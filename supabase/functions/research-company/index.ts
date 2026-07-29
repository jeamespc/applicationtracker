// Supabase Edge Function: research-company
// Fetches a company's site, tries to find a contact email and whether they
// have an active internship/job listing, and writes the result back onto
// the caller's own `studios` row. No AI/LLM involved - plain fetch + regex,
// so it's free to run and has no external API key dependency. Location is
// deliberately NOT attempted here - a script can't reliably infer it from
// unstructured HTML without an LLM doing the reading, and a wrong guess is
// worse than a blank field.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OPENING_KEYWORDS = /\b(intern(ship)?|stage|tirocinio|junior\s+(role|position|designer|architect)|apply\s+now|vacanc(y|ies)|job\s+opening|we'?re\s+hiring|now\s+hiring)\b/i;
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
    let openingsStatus: "Open listing found" | "Nothing posted" | "Couldn't determine" = "Couldn't determine";
    let openingsUrl = website;
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
          }
        }

        if (OPENING_KEYWORDS.test(html)) {
          openingsStatus = "Open listing found";
          openingsUrl = url;
          break; // good enough - stop crawling once we find a hit
        }
      } catch {
        // this path was unreachable/timed out - just move on to the next one
      }
    }

    if (openingsStatus === "Couldn't determine" && checkedAnyPage) {
      openingsStatus = "Nothing posted";
    }

    const updatePayload: Record<string, unknown> = {
      openings_status: openingsStatus,
      openings_url: openingsUrl,
      openings_note: "Auto-checked on add (keyword match against the site's own pages, no AI analysis).",
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
