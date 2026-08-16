import type { NextConfig } from "next"

const nextConfig: NextConfig = {
    rewrites: async () => {
        return [
            // Vercel deploys `api/index.py` as the literal `/api/index`
            // function. Route every public API URL to that function and carry
            // the original path so FastAPI can restore it before matching.
            // `next dev` has no Python runtime, so local requests still go to
            // uvicorn directly:
            //     uvicorn api.index:app --reload --port 5328
            process.env.NODE_ENV === "development"
                ? {
                      source: "/api/:path*",
                      destination: `${
                          process.env.NEXT_PUBLIC_FASTAPI_URL ??
                          "http://127.0.0.1:5328"
                      }/api/:path*`,
                  }
                : {
                      source: "/api/:path*",
                      destination: "/api/index?__democratune_api_path=:path*",
                  },
            {
                source: "/relay-iljT/static/:path*",
                destination: "https://eu-assets.i.posthog.com/static/:path*",
            },
            {
                source: "/relay-iljT/:path*",
                destination: "https://eu.i.posthog.com/:path*",
            },
        ]
    },
    images: {
        remotePatterns: [
            {
                hostname: "*.googleusercontent.com",
            },
        ],
    },
    skipTrailingSlashRedirect: true,
}

export default nextConfig
