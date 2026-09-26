# Terplus

- The long-term goal is a large Unicode character set for many languages and modern terminal applications. New glyphs will follow the visual style of Terminus Font. Emoji can use a different monochrome style.
- The BDF files in this directory contain the glyph artwork and Unicode encodings. Keep the console character set and aliases in `terplus.uni`.
- Keep the font family name `Terplus` in every BDF file and generated font. Do not use the reserved Terminus font name for the changed font.
- Use the same Unicode character set in all 18 normal and bold BDF files. Add each new glyph to these files. Draw its bitmap for each size and weight.
- Keep the original Terminus character set first in each BDF. Put added glyphs after `COMMENT End of Terminus glyphs. Terplus additions follow.` Keep glyph codes in numerical order within each section. Use each glyph code only once in each file.
- Keep the BDF `CHARS` count equal to the number of glyph blocks. Check the glyph bounding box and bitmap row count.
- The PCF font reads BMP encodings directly from BDF. The OTB font reads all BDF encodings and can include code points above the BMP.
- Keep console slot order and aliases in `terplus.uni`. Add a glyph to the console set only when its slot and aliases are defined.
- Run `node build.js` after a source or mapping change. Check the glyph in BDF, PCF, and OTB. Check PSF when the glyph is in the console set.
- `catalog.js` builds an offline HTML catalog of the glyphs in all 18 BDF files. Run `node catalog.js` to make `target/catalog.html`.
- The build uses only Node.js and the files in this directory. Do not add external dependencies or a build step that downloads another font.
- Keep `build.js` and `catalog.js` as the only JavaScript files. Use only built-in Node.js modules.

## Glyph drawing and checks

- Do not change original Terminus glyphs. Compare their glyph blocks before and after each source change. The blocks must remain byte-for-byte identical.
- Check the meaning of each new or changed character against Unicode references. Keep the features that identify the character.
- Draw each glyph for its size and weight. Do not use automatic scaling as the only drawing step. Emoji can use the same bitmap in normal and bold when this keeps the details clear.
- Use original Terminus glyphs at the same size and weight as references for stroke thickness, alignment, and spacing. Keep shapes simple and spaces within glyphs open. Emoji can use different shapes, but must fit the existing cells.
- Keep the same basic shape at all sizes. Keep the features that identify the character. Adjust strokes and gaps to fit each pixel grid. Use extra pixels at larger sizes to improve the shape and spacing. Do not add decoration only because more pixels are available.
- At small sizes, remove details only if they are not necessary to identify the character. Do not force every detail into the cell. If thicker strokes close necessary gaps, do not use them. If a feature cannot fit clearly, state the limit in the check results.
- Inspect the bitmaps saved in the BDF files at actual size. Also inspect enlarged copies. Use an integer scale factor with no smoothing. Check every size and weight.
- Compare related symbols together. Check that letters, numbers, arrows, and small marks are clear. Keep the features that make the symbols different.
- Check repeated glyphs and glyphs beside ordinary text and other symbols. Correct unwanted contact between cells. Keep the existing cell dimensions and advance widths.
- Compare new and changed bitmaps with the other glyphs in each font. Check for bitmaps copied in error. Different characters can share a bitmap when the same shape is correct for them. This is normal for some monochrome emoji, including emoji that differ only in color. Do not add marks only to make the bitmaps different.
- Compare compiled glyph bitmaps, advance widths, and positions with the BDF sources. Check OTB for all changed glyphs. Check PCF for changed BMP glyphs. Check PSF when the glyph is in the console set.
- Check that all other glyphs remain unchanged. Check that font spacing metrics remain unchanged. If the console set did not change, check that the PSF files remain byte-for-byte identical.
- State which details remain unclear and which sizes are affected. A glyph can pass the file checks and still be difficult to read. A successful build does not replace the visual checks.

## Coding standards

- At the start of each function, check inputs and the environment.
- Use `node:assert/strict` for invalid input and state.
- Import `assert` as the default export. Use `assert()` for condition checks.
- Do not use `else` blocks for the success path.
- Use braces for all control blocks, including `if` and loops.
- Do not use ternary expressions.
- Do not use `let` or `var`. Use small functions for conditional values.
- Do not use `throw`, `try`, `catch`, or `finally`.
- Prefer named top-level functions and top-level await.
- Keep module control code at the top level. Do not put it in a `main` function.
- Import `node:fs/promises` as `fs`. Do not use `node:fs`.
- Use `import.meta.dirname` for the script directory. Use `path.resolve` for file paths.
- Prefer namespace imports from other `node:*` modules. Do not use named or destructured Node imports.
- Keep functions small. Use names that describe their purpose. Do not add unnecessary blank lines inside functions.
- Keep code direct. Add a helper function only when its operation is needed more than once.
- Do not add comments unless the code is not clear without them.
- Keep one blank line between top-level declarations and test cases.
- Do not use dependency injection for tests. Mock globals or module boundaries.
- Prefer singular directory and file names.

## Commit messages

- Write commit messages in ASD-STE100 Simplified Technical English.
- Start the summary with a capital letter. Use 50 characters or less.
- Use the imperative form, such as "Fix error". Do not use "Fixed error" or "Fixes error".
- Add a body if the summary does not give enough information.
- Use an empty line between the summary and the body, and between paragraphs.
- Limit each body line to 72 characters.
- Start each bullet in the body with a hyphen and one space. Indent continuation lines to align with the text.

## Communication

- Write all text for the user in ASD-STE100 Simplified Technical English.
- Write all documentation in ASD-STE100 Simplified Technical English.
- Use short sentences, direct instructions, and consistent technical terms.
- Do not use ASD-STE100 Simplified Technical English for code.
- Use paragraphs or lists. Use tables only for short comparisons without links.
