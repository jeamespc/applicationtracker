// Supabase Edge Function: research-company
// Fetches a company's site and tries to find: a contact email, whether they
// have an active internship/job opportunity, their location, and their
// specialization. No AI/LLM involved - plain fetch + regex/JSON-LD parsing,
// so it's free to run and has no external API key dependency. Location and
// specialization are best-effort heuristics, not guaranteed - a script can't
// reliably read unstructured HTML the way an LLM would - but leaving them
// blank forever isn't useful either, so we try structured data first
// (JSON-LD / schema.org markup, the most reliable signal) and fall back to
// address/keyword regexes. To avoid clobbering good manually-curated data,
// location and specialization are only written when the studio's row for
// that field is still blank.
//
// Openings classifies into four states (matching the tracker's own categories):
//   "Open listing found" - a specific, dated/named role (strong signal).
//   "Open call"           - a standing invite to apply speculatively (a
//                           dedicated intake inbox, or generic "send your CV"
//                           / "join us" language) but no specific role.
//   "Nothing posted"      - pages were reachable, neither signal found.
//   "Couldn't determine"  - every path was unreachable/timed out.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Strong signal: an actual named/dated role exists.
const STRONG_LISTING_KEYWORDS = /\b(junior\s+(designer|architect|role|position)|open\s+position|we'?re\s+hiring|now\s+hiring|apply\s+by|application\s+deadline|job\s+opening|vacanc(y|ies))\b/i;
// Weak signal: a standing invite to apply speculatively, no specific role.
const WEAK_CALL_KEYWORDS = /\b(join\s+(the\s+)?team|join\s+us|work\s+with\s+us|lavora\s+con\s+noi|send\s+(us\s+)?your\s+cv|send\s+your\s+portfolio|unsolicited\s+application|spontaneous\s+application|collaborazioni|we'?re\s+always\s+looking|open\s+call)\b/i;
// A dedicated intake inbox (careers@, internship@, etc.) is itself a weak/"Open call" signal
// even if the surrounding page text doesn't match the phrases above.
const INTAKE_EMAIL_LOCAL_PART = /^(careers?|jobs?|internships?|stages?|recruiting|hr|apply|join)[\.\-_]?/i;

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const CAREER_PATHS = ["", "careers", "jobs", "en/careers", "en/jobs", "contact", "en/contact", "about", "lavora-con-noi", "join-us", "en/join-us"];
const FETCH_TIMEOUT_MS = 6000;

// Specialization keyword sets, matched against each fetched page's own text -
// same 6-tag vocabulary the tracker already uses (SPECIALIZATION_OPTIONS in index.html).
const SPECIALIZATION_KEYWORDS: Record<string, RegExp> = {
  Architecture: /\barchitect(ure|ural|s)?\b/i,
  Interior: /\binterior(s)?\s?(design)?\b/i,
  Exhibit: /\bexhibit(ion)?s?\b|\bscenograph(y|ic)?\b|\binstallation\s?design\b/i,
  Urban: /\burban(ism|\s?planning)?\b|\bmaster\s?plan(ning)?\b/i,
  Product: /\bproduct\s?design\b|\bindustrial\s?design\b/i,
  Manufacturing: /\bmanufactur(e|ing|er)\b|\bfactory\b/i,
};

// City name candidates for the plain-text location fallback - kept to the
// design/architecture hubs this tracker's studios actually cluster around,
// since an unbounded "any capitalized word" match is too noisy to trust.
const KNOWN_CITIES = [
  "Milan", "Milano", "Rome", "Roma", "Turin", "Torino", "Florence", "Firenze",
  "Bologna", "Genoa", "Genova", "Venice", "Venezia", "Naples", "Napoli",
  "London", "Paris", "Berlin", "Munich", "Munchen", "München", "Amsterdam",
  "Rotterdam", "Barcelona", "Madrid", "Copenhagen", "Stockholm", "Vienna",
  "Zurich", "Geneva", "New York", "Shanghai", "Beijing", "Tokyo", "Los Angeles",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function normalizeUrl(base: string, path: string): string | null {
  try {
    return new URL(path, base.endsWith("/") ? base : base + "/").toString();
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Tries schema.org JSON-LD (Organization/LocalBusiness address) first - the
// most reliable signal when present - then falls back to an Italian-style
// postal-code-plus-city pattern, then a plain "known city name" scan.
function extractLocation(html: string, text: string): string | null {
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of jsonLdBlocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        const addr = c?.address;
        const locality = addr?.addressLocality || addr?.["addressLocality"];
        if (locality && typeof locality === "string") return locality.trim();
      }
    } catch {
      // malformed/partial JSON-LD - skip it
    }
  }

  const capWord = "[A-ZÀ-Ý][a-zà-ÿ'\\-]+";
  const capPhrase = `${capWord}(?:\\s${capWord})*`;
  const italianCap = new RegExp(`\\b\\d{5}\\s+(${capPhrase})\\s*[,(]?\\s*(?:Italy|Italia|MI|IT)\\b`, "i");
  const italianMatch = text.match(italianCap);
  if (italianMatch) return italianMatch[1].trim();

  const basedIn = new RegExp(`\\b(?:based|located)\\s+in\\s+(${capPhrase})`, "i");
  const basedMatch = text.match(basedIn);
  if (basedMatch && KNOWN_CITIES.some((c) => c.toLowerCase() === basedMatch[1].toLowerCase())) {
    return basedMatch[1].trim();
  }

  for (const city of KNOWN_CITIES) {
    const re = new RegExp(`\\b${city}\\b`, "i");
    if (re.test(text)) return city;
  }

  return null;
}

function extractSpecializations(text: string): string {
  const hits: string[] = [];
  for (const [tag, re] of Object.entries(SPECIALIZATION_KEYWORDS)) {
    if (re.test(text)) hits.push(tag);
  }
  return hits.join(", ");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { studioId, website } = await req.json();
    if (!studioId || !website) {
      return new Response(JSON.stringify({ error: "studioId and website are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: existingRow } = await supabase
      .from("studios")
      .select("location, specialization")
      .eq("id", studioId)
      .maybeSingle();

    let foundEmail = "";
    let hasStrongSignal = false;
    let hasWeakSignal = false;
    let hitUrl = website;
    let checkedAnyPage = false;
    let ownDomain = "";
    let foundLocation: string | null = null;
    const specHits = new Set<string>();
    try { ownDomain = new URL(website).hostname.replace(/^www\./, ""); } catch { /* leave blank */ }

    for (const path of CAREER_PATHS) {
      const url = normalizeUrl(website, path);
      if (!url) continue;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) continue;
        checkedAnyPage = true;
        const html = await res.text();
        const text = stripTags(html);

        if (!foundEmail) {
          const emails = html.match(EMAIL_REGEX);
          if (emails && emails.length) {
            foundEmail = (ownDomain && emails.find((e) => e.toLowerCase().includes(ownDomain))) || emails[0];
            if (foundEmail) {
              const localPart = foundEmail.split("@")[0];
              if (INTAKE_EMAIL_LOCAL_PART.test(localPart)) hasWeakSignal = true;
            }
          }
        }

        if (!foundLocation) foundLocation = extractLocation(html, text);
        for (const tag of extractSpecializations(text).split(",").map((s) => s.trim()).filter(Boolean)) {
          specHits.add(tag);
        }

        if (STRONG_LISTING_KEYWORDS.test(html)) {
          hasStrongSignal = true;
          hitUrl = url;
          break; // strongest possible signal - stop crawling
        }
        if (WEAK_CALL_KEYWORDS.test(html) && !hasWeakSignal) {
          hasWeakSignal = true;
          hitUrl = url;
        }
      } catch {
        // this path was unreachable/timed out - just move on to the next one
      }
    }

    let openingsStatus: "Open listing found" | "Open call" | "Nothing posted" | "Couldn't determine";
    if (hasStrongSignal) openingsStatus = "Open listing found";
    else if (hasWeakSignal) openingsStatus = "Open call";
    else if (checkedAnyPage) openingsStatus = "Nothing posted";
    else openingsStatus = "Couldn't determine";

    const updatePayload: Record<string, unknown> = {
      openings_status: openingsStatus,
      openings_url: hitUrl,
      openings_note: "Auto-checked (keyword match against the site's own pages, no AI analysis).",
      openings_checked: new Date().toISOString().slice(0, 10),
    };
    if (foundEmail) updatePayload.contact = foundEmail;
    // Only fill location/specialization when the row doesn't already have a
    // value, so a bulk recheck never overwrites manually-curated data with a
    // weaker regex guess.
    if (foundLocation && !existingRow?.location) updatePayload.location = foundLocation;
    if (specHits.size && !existingRow?.specialization) updatePayload.specialization = [...specHits].join(", ");

    const { error } = await supabase.from("studios").update(updatePayload).eq("id", studioId);
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      email: foundEmail || null,
      location: foundLocation,
      specialization: specHits.size ? [...specHits].join(", ") : null,
      openingsStatus,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
