// A game's title as a SEARCH TERM, for the sources that match on words.
//
// Steam sells "Watch_Dogs™", and that spelling is what every later request is built from — which is
// where three sources go blind at once (measured 2026-08-22, appid 243470):
//
//   query            Wallhaven   Wallpaper Cave   Khinsider
//   Watch_Dogs™          0             0          20 albums, none of them this game ("Day Watch"…)
//   Watch_Dogs           0            59          the right ones
//   Watch Dogs          24           157          the right ones
//
// So the trademark marks and the underscore are removed here rather than in each provider. Steam's own
// store search and GOG's catalogue are NOT run through this: both find the game by its trademarked name
// perfectly well, and the candidate the user picks should keep the title the store actually uses.
//
// Deliberately shallow, and deliberately NOT `normalizeTitle` from service.ts: that one exists to decide
// whether two sources mean the same game and must never conflate two different ones, so it strips every
// punctuation mark. This one still has to produce something a search box can be given.

/** The marks publishers sprinkle into a name. None of them is ever part of what a site tagged a picture. */
const TRADEMARKS = /[™®©℠]/gu;

/**
 * A title as a search term: trademark marks dropped, underscores read as the spaces they stand for, and
 * the whitespace collapsed. Everything else — subtitles, colons, edition tails — is left to the callers,
 * which trim their own way (see `searchTerms` in wallhaven.ts).
 */
export function searchableTitle(title: string): string {
  return title.replace(TRADEMARKS, ' ').replaceAll('_', ' ').replace(/\s+/g, ' ').trim();
}
