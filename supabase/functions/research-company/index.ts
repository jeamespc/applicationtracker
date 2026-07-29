// Supabase Edge Function: research-company
// Fetches a company's site, tries to find a contact email and whether they
// have an active internship/job opportunity, and writes the result back onto
// the caller's own `studios` row. No AI/LLM involved - plain fetch + regex,
// so it's free to run and has no external API key dependency. Location is
// deliberately NOT attempted here - a script can't reliably infer it from
// unstructured HTML without an LLM doing the reading, and a wrong guess is
// worse than a blank field.
//
// Classifies into four states (matching the tracker's own categories):
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

    let foundEmail = "";
    let hasStrongSignal = false;
    let hasWeakSignal = false;
    let hitUrl = website;
    let checkedAnyPage = false;
    let ownDomain = "";
    try { ownDomain = new URL(website).hostname.replace(/^www\./, ""); } catch { /* leave blank */ }

    for (const path of CAREER_PATHS) {
      const url = normalizeUrl(website, path);
      if (!url) continue;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) continue;
        checkedAnyPage = true;
        const html = await res.text();

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

    const { error } = await supabase.from("studios").update(updatePayload).eq("id", studioId);
    if (error) throw error;

    return new Response(JSON.stringify({ ok: true, email: foundEmail || null, openingsStatus }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
