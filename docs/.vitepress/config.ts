import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Udu',
  description: 'Tribal Survival AI Sim — observasi karakter primitif yang belajar lewat Utility AI + LLM reflection',
  lang: 'id-ID',
  cleanUrls: true,

  themeConfig: {
    siteTitle: 'Udu Docs',

    nav: [
      { text: 'Guide', link: '/guide/vision' },
      { text: 'Tasks', link: '/tasks/' },
      { text: 'Dev Log', link: '/dev-log/' },
      { text: 'Context', link: '/context' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Project Spec',
          items: [
            { text: 'Vision', link: '/guide/vision' },
            { text: 'Tech Stack', link: '/guide/stack' },
            { text: 'Gameplay', link: '/guide/gameplay' },
            { text: 'AI Architecture', link: '/guide/ai-architecture' },
            { text: 'Data Model', link: '/guide/data-model' },
            { text: 'API Protocol', link: '/guide/api' },
            { text: 'Deployment', link: '/guide/deployment' },
            { text: 'Sprite Spec', link: '/guide/sprites' },
          ],
        },
      ],
      '/tasks/': [
        {
          text: 'Development Phases',
          items: [
            { text: 'Overview', link: '/tasks/' },
            { text: 'Phase 0 — Documentation', link: '/tasks/phase-0-documentation' },
            { text: 'Phase 1 — Foundation', link: '/tasks/phase-1-foundation' },
            { text: 'Phase 2 — Core Survival', link: '/tasks/phase-2-survival' },
            { text: 'Phase 3 — Hunting & Cooking', link: '/tasks/phase-3-hunting' },
            { text: 'Phase 4 — Learning Engine', link: '/tasks/phase-4-learning' },
            { text: 'Phase 5 — Death & Spirit Memory', link: '/tasks/phase-5-death' },
            { text: 'Phase 6 — Polish', link: '/tasks/phase-6-polish' },
          ],
        },
      ],
      '/dev-log/': [
        {
          text: 'Dev Log',
          items: [
            { text: 'Index', link: '/dev-log/' },
            { text: '2026-04-23 — Planning & Docs Init', link: '/dev-log/2026-04-23' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/nzib-id/udu' },
    ],

    footer: {
      message: 'Built by Loodee for Nzib.',
      copyright: 'udu.loodee.art',
    },

    search: {
      provider: 'local',
    },
  },
})
