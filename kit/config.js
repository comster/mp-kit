// Where the kit's shared service lives. One place, so every game picks a change up on its next sync.
//
// It is one small Cloudflare Worker (worker/ in the kit repo) that only answers the pages you allow:
//   /ice     relay servers for the roughly 1 player in 6 whose network blocks direct connections
//   /rooms   the list of public rooms, for "Quick play"
// null means no Worker: everyone connects directly or not at all, and there is no Quick play.
// Deploy your own (README, "The Worker") and put its address here, e.g.
//   'https://mp-kit-hub.<your-subdomain>.workers.dev'       Status: <HUB_URL>/status
export const HUB_URL = null;
export const ICE_URL = HUB_URL ? HUB_URL + '/ice' : null;
