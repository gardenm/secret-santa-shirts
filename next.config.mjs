/** @type {import('next').NextConfig} */
const nextConfig = {
  // resvg-js and sharp are native modules; they must not be bundled into the
  // serverless output or the prebuilt binaries get stripped.
  serverExternalPackages: ["@resvg/resvg-js", "sharp"],
};

export default nextConfig;
