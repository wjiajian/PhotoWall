/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TMDB_ACCESS_TOKEN?: string;
  readonly VITE_TMDB_API_KEY?: string;
}

declare module '*.md' {
  const content: string;
  export default content;
}
