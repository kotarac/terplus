# Terplus

Terplus is a bitmap font based on Terminus Font 4.49.1. It includes the `ll2` and `td1` variants and more glyphs. The font family name is Terplus.

All Terplus additions were made with AI. OpenAI models used were GPT-6-Astra, GPT-6-Sol, and Pro variants in ChatGPT. Glyph coverage is prioritized over quality. The goal is to reduce the need for fallback fonts. Current and future Terminus glyphs always take priority over Terplus additions.

The [glyph catalog](https://kotarac.github.io/terplus/) shows each glyph at all sizes and weights.

The long-term goal is a large Unicode character set for many languages and modern terminal applications. New glyphs will follow the visual style of Terminus Font.

Each BDF file holds the glyphs for one size and weight. `terplus.uni` holds the shared console character set and Unicode aliases. The build reads these files directly. It does not download or patch another font.

Run `node build.js` to make the PSF, PCF, and OTB files in `target/`. Run `node build.js psf`, `node build.js pcf`, or `node build.js otb` to make one format. Run `node build.js clean` to remove the output. Node.js is the only build requirement.

The font, build script, source data, documentation, and fontconfig file are licensed under the SIL Open Font License, Version 1.1. See `LICENSE`.
