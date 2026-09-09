import { useId } from 'react';

/*
 * ConsultTrack identity
 * ---------------------
 * The mark is a speech bubble with a check cut out of it: a consultation that
 * happened and was logged. That is the whole product in one glyph -- the bubble
 * is the meeting between a group and its adviser, the check is the record it
 * leaves behind. A graduation cap, which this replaces, said "university" and
 * nothing about what the tool does; every campus app is already wearing one.
 *
 * Three decisions worth keeping:
 *
 *   The tile is part of the logo, not a wrapper the call site improvises. It
 *   travels with the mark, so the corner radius and the maroon are the same in
 *   the sidebar, on the sign-in screen and in the browser tab.
 *
 *   The check is knocked out through a mask rather than painted on top, so the
 *   tile gradient shows through it. Paint it and the check has to know the tile
 *   colour; knock it out and it never does.
 *
 *   The geometry is optically centred, not mathematically centred. The tail is
 *   a thin appendage that carries little visual weight, so centring the full
 *   bounding box would leave the body of the bubble sitting high.
 */

/* 24-unit glyph. Bubble body y 3..18, tail hanging to y 21.35. */
const BUBBLE =
  'M7 3H17A4.5 4.5 0 0 1 21.5 7.5V13.5A4.5 4.5 0 0 1 17 18H11.6L8.1 21.35A0.9 0.9 0 0 1 6.6 20.7V17.9A4.5 4.5 0 0 1 2.5 13.5V7.5A4.5 4.5 0 0 1 7 3Z';
const CHECK = 'M8.2 10.6 10.9 13.3 15.9 8.3';

const BRAND_600 = '#a82f4e';
const BRAND_800 = '#671a2c';

/**
 * The full mark: maroon tile, white bubble, tile showing through the check.
 * Size it from the outside -- `<Logo className="h-9 w-9" />`.
 */
export default function Logo({ className = '', title = 'ConsultTrack' }) {
  // useId returns ':r0:'-style strings; the colons are legal in a fragment
  // reference but trip up anything that later treats the id as a selector.
  const uid = useId().replace(/:/g, '');
  const tile = `ct-tile-${uid}`;
  const knock = `ct-knock-${uid}`;

  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label={title}>
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={BRAND_600} />
          <stop offset="1" stopColor={BRAND_800} />
        </linearGradient>
        <mask id={knock}>
          {/* White shows, black hides. */}
          <rect width="48" height="48" fill="black" />
          <g transform="translate(10.2 11) scale(1.15)">
            <path d={BUBBLE} fill="white" />
            <path
              d={CHECK}
              fill="none"
              stroke="black"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        </mask>
      </defs>

      <rect width="48" height="48" rx="13" fill={`url(#${tile})`} />
      {/* A hairline of light along the tile edge, so it reads as a surface. */}
      <rect
        x="0.6"
        y="0.6"
        width="46.8"
        height="46.8"
        rx="12.4"
        fill="none"
        stroke="white"
        strokeOpacity="0.18"
        strokeWidth="1.2"
      />
      <rect width="48" height="48" fill="white" mask={`url(#${knock})`} />
    </svg>
  );
}

/**
 * The bare glyph in `currentColor`, for places that already have a ground of
 * their own -- a flat one-colour print, a favicon fallback, a dense table row.
 */
export function LogoMark({ className = '', title = 'ConsultTrack' }) {
  const uid = useId().replace(/:/g, '');
  const knock = `ct-mark-${uid}`;

  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label={title}>
      <defs>
        <mask id={knock}>
          <rect width="24" height="24" fill="black" />
          <path d={BUBBLE} fill="white" />
          <path
            d={CHECK}
            fill="none"
            stroke="black"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </mask>
      </defs>
      <rect width="24" height="24" fill="currentColor" mask={`url(#${knock})`} />
    </svg>
  );
}
