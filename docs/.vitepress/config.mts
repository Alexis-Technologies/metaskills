import { createRequire } from 'node:module';
import { defineConfig } from 'vitepress';

// The nav version label is read from package.json at config load, so a release
// needs no hand-edit here.
const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const description =
  'Agent skills for the Alexis JavaScript stack: reusable instructions for Claude Code, Cursor, ' +
  'Windsurf, VS Code and Gemini, linked into a project by one command.';
const repo = 'https://github.com/Alexis-Technologies/metaskills';

// No sitemap, canonical or og:url yet: the site has no domain until a Vercel project exists.
export default defineConfig({
  title: '@alexify/metaskills',
  titleTemplate: ':title — metaskills',
  description,
  lang: 'en-US',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#7C5CFF' }],
    ['meta', { name: 'author', content: 'Alexis Technologies' }],
  ],

  themeConfig: {
    logo: { light: '/logo-mark.svg', dark: '/logo-mark-dark.svg', alt: 'metaskills' },

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Skills', link: '/reference/skills', activeMatch: '/reference/' },
      {
        text: `v${version}`,
        items: [{ text: 'Changelog', link: `${repo}/blob/main/CHANGELOG.md` }],
      },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Packs', link: '/guide/packs' },
          { text: 'Skill format', link: '/guide/skill-format' },
          { text: 'Upstream', link: '/guide/upstream' },
        ],
      },
      {
        text: 'Reference',
        items: [{ text: 'Skills', link: '/reference/skills' }],
      },
    ],

    search: { provider: 'local' },

    socialLinks: [{ icon: 'github', link: repo }],

    editLink: {
      pattern: `${repo}/edit/main/docs/:path`,
      text: 'Edit this page on GitHub',
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026 Metarhia contributors · © 2026 Alexis Technologies',
    },

    docFooter: {
      prev: 'Previous page',
      next: 'Next page',
    },
  },
});
