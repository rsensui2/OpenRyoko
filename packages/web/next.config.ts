import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";
import type { NextConfig } from "next";

export default (phase: string): NextConfig => {
  const config: NextConfig = {
    distDir: "out",
  };

  if (phase === PHASE_DEVELOPMENT_SERVER) {
    const gatewayPort = process.env.GATEWAY_PORT ?? "7777";
    config.rewrites = async () => [
      { source: "/api/:path*", destination: `http://127.0.0.1:${gatewayPort}/api/:path*` },
      { source: "/ws", destination: `http://127.0.0.1:${gatewayPort}/ws` },
    ];
  } else {
    config.output = "export";
  }

  return config;
};
