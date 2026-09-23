// Supabase Edge Function: research-company
// Fetches a company's site and tries to fill in everything the tracker can
// reasonably infer without an LLM: contact email, location, specialization,
// team size, contact channel, discipline, and whether they have an active
// internship/job opportunity. No AI/LLM involved - plain fetch +
// regex/JSON-LD parsing, so it's free to run and has no external API key
// dependency. Location, specialization and team size are best-effort
// heuristics, not guaranteed - a script can't reliably read unstructured
// HTML the way an LLM would - but leaving them blank forever isn't useful
// either, so we try structured data first (JSON-LD / schema.org markup, the
// most reliable signal) and fall back to regexes. To avoid clobbering good
// manually-curated data, every researched field below is only written when
// the studio's row for that field is still blank (contact and the openings
// fields are the exception - those always refresh, since they're meant to
// reflect the current state of the site).
//
// Openings classifies into four states (matching the tracker's own categories):
//   "Open listing found" - a specific, dated/named role (strong signal).
//   "Open call"           - a standing invite to apply speculatively (a
//                           dedicated intake inbox, or generic "send your CV"
//                           / "join us" language) but no specific role.
//   "Nothing posted"      - pages were reachable, neither signal found.
//   "Uncertain"           - every path was unreachable/timed out.

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
// used to auto-detect a STUDIO's own specialty (extractSpecializations
// below). "Intern" deliberately isn't here - internship-ness is an
// experience level, not something a studio "specializes" in; that's now its
// own EXPERIENCE_LEVEL_KEYWORDS concept further down.
const SPECIALIZATION_KEYWORDS: Record<string, RegExp> = {
  Architecture: /\barchitect(ure|ural|s)?\b/i,
  Interior: /\binterior(s)?\s?(design)?\b/i,
  Exhibit: /\bexhibit(ion)?s?\b|\bscenograph(y|ic)?\b|\binstallation\s?design\b/i,
  Urban: /\burban(ism|\s?planning)?\b|\bmaster\s?plan(ning)?\b/i,
  Product: /\bproduct\s?design\b|\bindustrial\s?design\b/i,
  Manufacturing: /\bmanufactur(e|ing|er)\b|\bfactory\b/i,
  Retail: /\bretail(er)?\b|\bstore\s?design\b|\bshop(ping)?\s?(fit-?out|design)\b/i,
  Fashion: /\bfashion\b|\bapparel\b/i,
};

// Synonym clusters for DESIGN roles only - deliberately not a general-purpose
// synonym engine. Each cluster lists every phrasing a user might type as
// their own profile role (aliases, matched case-insensitively as a whole
// role name) plus the regex of equivalent language a studio's own page
// might use for that same discipline, so "Spatial Design" also catches a
// studio calling it "Environmental Design" or "Experiential Design" instead.
// A role that doesn't match any cluster (e.g. a non-design role, or an
// experience level like "Intern") gets no synonym expansion - see
// keywordRegexForRole()'s literal fallback.
const DESIGN_SYNONYM_CLUSTERS: { aliases: string[]; pattern: RegExp }[] = [
  {
    aliases: ["architecture", "architect", "architectural design"],
    pattern: /\barchitect(ure|ural|s)?\b/i,
  },
  {
    aliases: ["interior design", "interior designer", "interior"],
    pattern: /\binterior(s)?\s?(design(er)?)?\b/i,
  },
  {
    aliases: ["exhibit", "exhibition design", "exhibition", "installation design", "scenography", "scenographic design"],
    pattern: /\bexhibit(ion)?s?\b|\bscenograph(y|ic)?\b|\binstallation\s?design\b/i,
  },
  {
    aliases: ["urban design", "urban planning", "urbanism", "urban"],
    pattern: /\burban(ism|\s?planning)?\b|\bmaster\s?plan(ning)?\b/i,
  },
  {
    aliases: ["product design", "product designer", "industrial design"],
    pattern: /\bproduct\s?design\b|\bindustrial\s?design\b/i,
  },
  {
    aliases: ["manufacturing", "manufacturing design"],
    pattern: /\bmanufactur(e|ing|er)\b|\bfactory\b/i,
  },
  {
    aliases: ["retail design", "retail", "store design", "shop design", "shopfitting"],
    pattern: /\bretail(er)?\b|\bstore\s?design\b|\bshop(ping)?\s?(fit-?out|design)\b/i,
  },
  {
    aliases: ["fashion design", "fashion", "apparel design"],
    pattern: /\bfashion\b|\bapparel\b/i,
  },
  {
    aliases: ["spatial design", "spatial designer", "environmental design", "experiential design", "experience design", "immersive design"],
    pattern: /\bspatial\s?design\b|\benvironmental\s?design\b|\bexperiential\s?design\b|\bexperience\s?design\b|\bimmersive\s?design\b/i,
  },
  {
    aliases: ["graphic design", "graphic designer", "visual design", "visual communication"],
    pattern: /\bgraphic\s?design\b|\bvisual\s?(design|communication)\b/i,
  },
  {
    aliases: ["landscape design", "landscape architecture", "landscape"],
    pattern: /\blandscape\s?(design|architect(ure)?)?\b/i,
  },
  {
    aliases: ["lighting design", "lighting designer"],
    pattern: /\blighting\s?design\b/i,
  },
  {
    aliases: ["furniture design", "furniture designer"],
    pattern: /\bfurniture\s?design\b/i,
  },
];

// Experience-level keyword sets, ranked low-to-high seniority. Unlike roles,
// this is a fixed, closed vocabulary (EXPERIENCE_LEVEL_OPTIONS in index.html)
// - no free text, no synonym expansion needed beyond what's listed here.
const EXPERIENCE_LEVEL_RANK: Record<string, number> = { Internship: 0, Junior: 1, "Mid-Level": 2, Senior: 3 };
const EXPERIENCE_LEVEL_KEYWORDS: Record<string, RegExp> = {
  Internship: /\bintern(ship)?s?\b|\btrainee\b|\bstage\b|\bstagista\b|\bgraduate\s?(scheme|program(me)?)?\b/i,
  Junior: /\bjunior\b|\bentry[\s-]level\b|\b0[\s-]?(to|-)\s?2\s*years?\b/i,
  "Mid-Level": /\bmid[\s-]level\b|\bintermediate\b|\b2[\s-]?(to|-)\s?5\s*years?\b/i,
  Senior: /\bsenior\b|\blead\b|\bhead\s+of\b|\bdirector\b|\bprincipal\b|\b5\+\s*years?\b/i,
};

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

// Tries schema.org JSON-LD (Organization/LocalBusiness address) first, then
// SEO geo <meta> tags, then an Italian-style postal-code-plus-city pattern,
// then explicit "based in / located in / headquartered in X" phrasing.
// Deliberately does NOT fall back to "does any known city name appear
// anywhere on this page" - that produced false positives (e.g. a studio's
// past project in Rome getting mistaken for its Seattle HQ), which is worse
// than leaving the field blank. Every signal here is anchored to something
// that actually asserts a location, not just a stray mention.
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

  const metaGeo = html.match(/<meta[^>]+(?:name|property)=["'](?:geo\.placename|business:contact_data:locality|og:locality)["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:geo\.placename|business:contact_data:locality|og:locality)["']/i);
  if (metaGeo && metaGeo[1].trim()) return metaGeo[1].trim();

  const capWord = "[A-ZÀ-Ý][a-zà-ÿ'\\-]+";
  const capPhrase = `${capWord}(?:\\s${capWord})*`;
  const italianCap = new RegExp(`\\b\\d{5}\\s+(${capPhrase})\\s*[,(]?\\s*(?:Italy|Italia|MI|IT)\\b`, "i");
  const italianMatch = text.match(italianCap);
  if (italianMatch) return italianMatch[1].trim();

  const basedIn = new RegExp(`\\b(?:based|located|headquartered)\\s+in\\s+(?:the\\s+)?(${capPhrase})`, "i");
  const basedMatch = text.match(basedIn);
  if (basedMatch) return basedMatch[1].trim();

  return null;
}

function extractSpecializations(text: string): string {
  const hits: string[] = [];
  for (const [tag, re] of Object.entries(SPECIALIZATION_KEYWORDS)) {
    if (re.test(text)) hits.push(tag);
  }
  return hits.join(", ");
}

// A profile role gets synonym expansion only when it's recognized as a
// DESIGN role (an exact, case-insensitive match against a DESIGN_SYNONYM_
// CLUSTERS alias). Anything else - a non-design role, or text that isn't a
// known design term - falls back to a literal, word-boundary match on its
// own text, same as before: the best a keyword-matching script can do for
// free text it has no vocabulary for.
function keywordRegexForRole(role: string): RegExp {
  const norm = role.trim().toLowerCase();
  const cluster = DESIGN_SYNONYM_CLUSTERS.find((c) => c.aliases.includes(norm));
  if (cluster) return cluster.pattern;
  const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i");
}

// Gates a page's hiring-signal match against the roles the user set on their
// profile: an "Open listing"/"Open call" only counts when the same page also
// mentions one of those roles, so a generic "we're hiring" for an unrelated
// position (e.g. an accountant) doesn't get flagged for a designer. No roles
// set on the profile yet means don't gate at all - fall back to the old
// unfiltered behavior.
function pageMatchesRoles(text: string, roles: string[]): boolean {
  if (roles.length === 0) return true;
  return roles.some((role) => keywordRegexForRole(role).test(text));
}

// Gates a page against the experience level(s) the user picked: excludes it
// only when the page signals a level ranked ABOVE every level the user
// wants - e.g. wanting only "Internship" excludes a page that says "Senior
// Architect", but a page with no level language at all (a generic "we're
// hiring") still passes, since that absence isn't evidence it's the wrong
// level. No levels selected means don't gate at all.
function pageMatchesExperienceLevels(text: string, levels: string[]): boolean {
  if (levels.length === 0) return true;
  const wantedMax = Math.max(...levels.map((l) => EXPERIENCE_LEVEL_RANK[l] ?? 0));
  for (const [level, re] of Object.entries(EXPERIENCE_LEVEL_KEYWORDS)) {
    if (EXPERIENCE_LEVEL_RANK[level] > wantedMax && re.test(text)) return false;
  }
  return true;
}

const WORD_TO_NUMBER: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  duo: 2, trio: 3,
};

// Best-effort headcount guess from common phrasing ("team of 12", "a team of
// three architects", "20+ employees"). Returns a display string like the
// tracker's own manually-entered examples ("~12", "3 founders") or null.
function extractTeamSize(text: string): string | null {
  const numeric = text.match(/\b(?:team of|a team of|we are|staff of)\s+(\d{1,3})\b/i)
    || text.match(/\b(\d{1,3})\+?\s*(?:people|employees|staff|architects|designers|professionals|team\s?members)\b/i);
  if (numeric) return `~${numeric[1]}`;

  const worded = text.match(/\b(two|three|four|five|six|seven|eight|nine|ten|duo|trio)\s+(?:founders?|partners?|architects?|designers?)\b/i);
  if (worded) {
    const n = WORD_TO_NUMBER[worded[1].toLowerCase()];
    if (n) return `${n} founders`;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { studioId, website, profileRoles, experienceLevels } = await req.json();
    if (!studioId || !website) {
      return new Response(JSON.stringify({ error: "studioId and website are required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const roleList = typeof profileRoles === "string"
      ? profileRoles.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
    const levelList = typeof experienceLevels === "string"
      ? experienceLevels.split(",").map((s) => s.trim()).filter((s) => s in EXPERIENCE_LEVEL_RANK)
      : [];

    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: existingRow } = await supabase
      .from("studios")
      .select("location, specialization, team_size, channel, discipline")
      .eq("id", studioId)
      .maybeSingle();

    let foundEmail = "";
    let hasStrongSignal = false;
    let hasWeakSignal = false;
    let hitUrl = website;
    let checkedAnyPage = false;
    let ownDomain = "";
    let foundLocation: string | null = null;
    let foundTeamSize: string | null = null;
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
        if (!foundTeamSize) foundTeamSize = extractTeamSize(text);
        for (const tag of extractSpecializations(text).split(",").map((s) => s.trim()).filter(Boolean)) {
          specHits.add(tag);
        }

        const roleOk = pageMatchesRoles(text, roleList);
        const levelOk = pageMatchesExperienceLevels(text, levelList);
        if (STRONG_LISTING_KEYWORDS.test(html) && roleOk && levelOk) {
          hasStrongSignal = true;
          hitUrl = url;
          break; // strongest possible signal - stop crawling
        }
        if (WEAK_CALL_KEYWORDS.test(html) && roleOk && levelOk && !hasWeakSignal) {
          hasWeakSignal = true;
          hitUrl = url;
        }
      } catch {
        // this path was unreachable/timed out - just move on to the next one
      }
    }

    let openingsStatus: "Open listing found" | "Open call" | "Nothing posted" | "Uncertain";
    if (hasStrongSignal) openingsStatus = "Open listing found";
    else if (hasWeakSignal) openingsStatus = "Open call";
    else if (checkedAnyPage) openingsStatus = "Nothing posted";
    else openingsStatus = "Uncertain";

    const filterBits = [
      roleList.length ? `${roleList.join(", ")} roles` : null,
      levelList.length ? `${levelList.join(", ")} level` : null,
    ].filter(Boolean);
    const updatePayload: Record<string, unknown> = {
      openings_status: openingsStatus,
      openings_url: hitUrl,
      openings_note: filterBits.length
        ? `Auto-checked for ${filterBits.join(", ")} (keyword match against the site's own pages, no AI analysis).`
        : "Auto-checked (keyword match against the site's own pages, no AI analysis).",
      openings_checked: new Date().toISOString().slice(0, 10),
    };
    if (foundEmail) {
      updatePayload.contact = foundEmail;
      if (!existingRow?.channel) updatePayload.channel = "Email";
    } else if (checkedAnyPage && !existingRow?.channel) {
      updatePayload.channel = "Website";
    }

    const specJoined = specHits.size ? [...specHits].join(", ") : null;

    // Only fill location/specialization/team size/discipline when the row
    // doesn't already have a value, so a bulk recheck never overwrites
    // manually-curated data with a weaker regex guess.
    if (foundLocation && !existingRow?.location) updatePayload.location = foundLocation;
    if (specJoined && !existingRow?.specialization) updatePayload.specialization = specJoined;
    if (foundTeamSize && !existingRow?.team_size) updatePayload.team_size = foundTeamSize;
    // Discipline is a free-text summary; a script can't write real prose about
    // a studio's practice without an LLM reading the whole site, so this just
    // mirrors the detected specialization tags as a readable line - better
    // than leaving it blank, but flagged here as the honest limit of what a
    // keyword-matching approach can produce.
    if (specJoined && !existingRow?.discipline) updatePayload.discipline = specJoined;

    const { error } = await supabase.from("studios").update(updatePayload).eq("id", studioId);
    if (error) throw error;

    return new Response(JSON.stringify({
      ok: true,
      email: foundEmail || null,
      location: foundLocation,
      specialization: specJoined,
      teamSize: foundTeamSize,
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
