#!/bin/bash
# Reference implementation for cardboard-cutout text rendering (name tags,
# signage). This is a bash/ImageMagick stand-in for whatever eventually
# renders this in-game (no JS/three.js version exists yet — see TODO.md,
# "Cardboard lettering: name tags and signage" for the full history and
# what still needs building). The four constants below are FINAL, agreed
# with Luke on 2026-08-30 via a live slider prototype (app/descender-tuner.html)
# — do not re-derive or "improve" them without cause; if the source art
# changes, re-run that prototype rather than guessing new numbers.
set -e
UPPER="C:/Users/LukeD/Projects/Pick a Path/app/public/textures/letters/upper-v2"
LOWER="C:/Users/LukeD/Projects/Pick a Path/app/public/textures/letters/lower"
CARD="C:/Users/LukeD/Projects/Pick a Path/Assets/Card Background.png"
OUT_DIR="C:/Users/LukeD/Projects/Pick a Path/Assets/word-previews"
TMP=/tmp/cardcheck/sentences
mkdir -p "$OUT_DIR" "$TMP"

SENTENCE="$1"
NAME="$2"

UPPER_H=150
LOWER_H=105          # lowercase = 70% of uppercase height, agreed 2026-08-29
SPACING=10           # gap between ordinary letters
WORD_GAP=34           # extra gap between words (on top of SPACING)
PAD_X=40
PAD_Y=40
BASELINE_Y=$((PAD_Y + UPPER_H))
DESC_OFFSET=6         # FINAL: g/j/p/q/y shift down 6px from bottom-aligned bbox, agreed 2026-08-30
J_SCALE_PCT=115       # FINAL: lowercase j rendered at 115% size, agreed 2026-08-30
# FINAL, agreed 2026-08-31 -- see nameTag.js's GAMMA_DEFAULT/CONTRAST_DEFAULT/
# SATURATION_DEFAULT. GAMMA maps directly to ImageMagick's -gamma (same
# input^(1/gamma) formula as the canvas version). CONTRAST/SATURATION are
# approximations of the canvas version's CSS contrast()/saturate() filters --
# -brightness-contrast and -modulate use different curves, so treat this
# script's color output as "close enough for a preview," not pixel-identical
# to what actually ships in-game.
GAMMA=0.85       # updated 2026-08-30 to match nameTag.js's GAMMA_DEFAULT (was 0.95)
CONTRAST_PCT=40       # -brightness-contrast contrast param, approximating CSS contrast(140%)
SATURATION_PCT=130    # -modulate saturation param, approximating CSS saturate(130%)

is_descender() { case "$1" in g|j|p|q|y) return 0;; *) return 1;; esac; }

# Per-letter size corrections, agreed with Luke 2026-08-31 after he compared
# every lowercase letter side by side in app/letter-size-tuner.html. Percents
# multiply on top of whatever a letter's height already was (LOWER_H
# normally, LOWER_H*J_SCALE_PCT for j) -- see nameTag.js's LETTER_SCALE
# comment for the fuller explanation, keep the two in sync.
letter_scale_pct() {
  case "$1" in
    b) echo 118;; d) echo 115;; f) echo 114;; g) echo 106;; h) echo 124;;
    i) echo 119;; j) echo 115;; l) echo 115;; p) echo 112;; q) echo 105;;
    t) echo 115;; u) echo 90;;
    *) echo 100;;
  esac
}

cd "$TMP"
rm -f parts_${NAME}_*.png
letters=()   # each entry: file:width:height:extraGapLeft:extraGapRight:isSpace
total_w=0
idx=0
len=${#SENTENCE}
for (( i=0; i<len; i++ )); do
  ch="${SENTENCE:$i:1}"
  if [ "$ch" = " " ]; then
    letters+=("SPACE::::")
    total_w=$((total_w + WORD_GAP))
    continue
  fi
  f="p_${NAME}_${idx}.png"
  idx=$((idx + 1))
  if [[ "$ch" =~ [A-Z] ]]; then
    magick "$UPPER/$ch.png" -resize x${UPPER_H} "$f"
    h=$UPPER_H
    gl=0; gr=$SPACING
  else
    h=$LOWER_H
    if [ "$ch" = "j" ]; then
      h=$(awk -v h="$h" -v p="$J_SCALE_PCT" 'BEGIN{printf "%.0f", h*p/100}')
    fi
    extra_pct=$(letter_scale_pct "$ch")
    h=$(awk -v h="$h" -v p="$extra_pct" 'BEGIN{printf "%.0f", h*p/100}')
    magick "$LOWER/$ch.png" -resize x${h} "$f"
    # extra side-gap grows with how much taller than a plain lowercase
    # letter this glyph ends up (generalises the old j-only rule)
    ratio=$(awk -v h="$h" -v base="$LOWER_H" 'BEGIN{printf "%.4f", h/base}')
    if awk -v r="$ratio" 'BEGIN{exit !(r>1)}'; then
      gl=$(awk -v s="$SPACING" -v r="$ratio" 'BEGIN{printf "%.1f", s*(r-1)}')
      gr=$(awk -v s="$SPACING" -v r="$ratio" 'BEGIN{printf "%.1f", s*r}')
    else
      gl=0; gr=$SPACING
    fi
  fi
  w=$(magick "$f" -format "%w" info:)
  letters+=("$f:$w:$h:$gl:$gr:$ch")
  total_w=$((total_w + w + SPACING))
done
total_w=$((total_w + PAD_X*2 + 60))   # generous slack for j's extra side-gaps at J_SCALE_PCT
total_h=$((PAD_Y + UPPER_H + PAD_Y + 20))   # +20 slack for the deepened descenders

magick "$CARD" -resize ${total_w}x -gravity center -crop ${total_w}x${total_h}+0+0 +repage bg_${NAME}.png

canvas="bg_${NAME}.png"
x=$PAD_X
for entry in "${letters[@]}"; do
  if [[ "$entry" == SPACE* ]]; then
    x=$((x + WORD_GAP))
    continue
  fi
  IFS=':' read -r f w h gl gr ch <<< "$entry"
  gl_i=$(awk -v v="$gl" 'BEGIN{printf "%.0f", v}')
  x=$((x + gl_i))
  y=$((BASELINE_Y - h))
  if is_descender "$ch"; then
    y=$((y + DESC_OFFSET))
  fi
  magick "$f" \( +clone -background black -shadow 35x3+2+4 \) +swap -background none -layers merge +repage sh_${NAME}_$x.png
  magick "$canvas" sh_${NAME}_$x.png -geometry +${x}+${y} -compose over -composite next_${NAME}.png
  mv next_${NAME}.png "$canvas"
  gr_i=$(awk -v v="$gr" 'BEGIN{printf "%.0f", v}')
  x=$((x + w + gr_i))
done
magick "$canvas" -gamma $GAMMA -brightness-contrast 0x${CONTRAST_PCT} -modulate 100,${SATURATION_PCT},100 "$OUT_DIR/${NAME}.png"
echo "wrote $OUT_DIR/${NAME}.png"
