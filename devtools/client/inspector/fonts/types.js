/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const PropTypes = require("devtools/client/shared/vendor/react-prop-types");

/**
 * A single font.
 */
const font = exports.font = {
  // The name of the font family
  CSSFamilyName: PropTypes.string,

  // The format of the font
  format: PropTypes.string,

  // The name of the font
  name: PropTypes.string,

  // URL for the font preview
  previewUrl: PropTypes.string,

  // Object containing the CSS rule for the font
  rule: PropTypes.object,

  // The text of the CSS rule
  ruleText: PropTypes.string,

  // The URI of the font file
  URI: PropTypes.string,
};

exports.fontOptions = {
  // The current preview text
  previewText: PropTypes.string,
};

/**
 * Font data
 */
exports.fontData = {
  // The fonts used in the current element.
  fonts: PropTypes.arrayOf(PropTypes.shape(font)),

  // Fonts used elsewhere.
  otherFonts: PropTypes.arrayOf(PropTypes.shape(font)),
};
