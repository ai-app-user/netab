# Google Style Adoption

This project adopts Google-originated style references for the languages used in
the repo and keeps local snapshots of the upstream documents for repeatable
review.

Downloaded on: `2026-04-11`

Relevant references:

- TypeScript: `docs/style/google/sources/tsguide.html`
  Source: <https://google.github.io/styleguide/tsguide.html>
- JavaScript formatting details used by the TypeScript guide:
  `docs/style/google/sources/jsguide.html`
  Source: <https://google.github.io/styleguide/jsguide.html>
- Shell: `docs/style/google/sources/shellguide.html`
  Source: <https://google.github.io/styleguide/shellguide.html>
- Android Kotlin: `docs/style/google/sources/android-kotlin-style-guide.html`
  Source: <https://developer.android.com/kotlin/style-guide>
- Google styleguide repository license snapshot:
  `docs/style/google/sources/google-styleguide-LICENSE`
  Source:
  <https://raw.githubusercontent.com/google/styleguide/gh-pages/LICENSE>

Project formatter choices:

- TypeScript, JavaScript, JSON, and Markdown are formatted with Prettier using
  Google-aligned defaults:
  `80` columns, single quotes, semicolons, trailing commas, and two-space
  indentation.
- Kotlin is formatted with `ktlint` using the `android_studio` code style,
  which is based on the Android Kotlin style guide.
- Shell scripts are formatted with `shfmt` using two-space indentation and
  Google shell guide conventions.

Run the formatter:

```bash
npm run format:google
```

Check the formatter without changing files:

```bash
npm run format:google:check
```

Compatibility note:

The repo intentionally keeps existing public API names such as
`ensure_table` and `get_objs`. Google style guides would normally prefer more
idiomatic camelCase naming for many of these APIs, but changing them would be a
breaking API change. Formatting and layout are aligned with the guides; public
surface naming remains compatibility-first unless a dedicated breaking rename
pass is approved.
