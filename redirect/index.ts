// The bioc-prop hostname, permanently redirected to bioc-registry.
// Deployed over the old worker name: replacing it removes the old cron,
// bucket bindings and pre-guard maintenance routes in the same stroke.
export default {
  fetch(req: Request): Response {
    const url = new URL(req.url);
    url.hostname = "bioc-registry.seandavi.workers.dev";
    return new Response(null, {
      status: 301,
      headers: { location: url.toString(), "cache-control": "public, max-age=86400" },
    });
  },
};
