import type { Metadata } from "next";

// Prefer NEXT_PUBLIC_PRODUCTION_URL (set at build time for live domain) so
// OG/Twitter images resolve to an absolute public URL, not localhost.
const baseUrl = process.env.NEXT_PUBLIC_PRODUCTION_URL
  ? process.env.NEXT_PUBLIC_PRODUCTION_URL.startsWith("http")
    ? process.env.NEXT_PUBLIC_PRODUCTION_URL
    : `https://${process.env.NEXT_PUBLIC_PRODUCTION_URL}`
  : process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : `http://localhost:${process.env.PORT || 3000}`;

export const getMetadata = ({
  title,
  description,
  imageRelativePath = "/thumbnail.jpg",
}: {
  title: string;
  description: string;
  imageRelativePath?: string;
}): Metadata => {
  const imageUrl = `${baseUrl}${imageRelativePath}`;

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: title,
      template: "%s",
    },
    description: description,
    openGraph: {
      title: {
        default: title,
        template: "%s",
      },
      description: description,
      images: [
        {
          url: imageUrl,
        },
      ],
    },
    twitter: {
      title: {
        default: title,
        template: "%s",
      },
      description: description,
      images: [imageUrl],
    },
    icons: {
      icon: [
        {
          url: "/favicon.svg",
          type: "image/svg+xml",
        },
      ],
    },
  };
};
