export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sources = {
      "/data/world-cup-2026.txt": "https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup.txt",
      "/data/international-results.csv": "https://raw.githubusercontent.com/martj42/international_results/master/results.csv",
    };
    if (sources[url.pathname]) {
      const cache = caches.default;
      const cacheKey = new Request(url.origin + url.pathname);
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
      const upstream = await fetch(sources[url.pathname], { headers: { "User-Agent": "football-data-lab" } });
      if (!upstream.ok) return new Response("Public football dataset is temporarily unavailable", { status: 502 });
      const response = new Response(upstream.body, {
        headers: {
          "Cache-Control": "public, max-age=3600, s-maxage=86400",
          "Content-Type": url.pathname.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/plain; charset=utf-8",
        },
      });
      await cache.put(cacheKey, response.clone());
      return response;
    }
    return env.ASSETS.fetch(request);
  },
};
