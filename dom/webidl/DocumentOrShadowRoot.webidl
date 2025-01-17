/* -*- Mode: IDL; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * The origin of this IDL file is
 * https://dom.spec.whatwg.org/#documentorshadowroot
 * http://w3c.github.io/webcomponents/spec/shadow/#extensions-to-the-documentorshadowroot-mixin
 */

[NoInterfaceObject]
interface DocumentOrShadowRoot {
  // Not implemented yet: bug 1430308.
  // Selection? getSelection();
  // Not implemented yet: bug 1430301.
  // Element? elementFromPoint (float x, float y);
  // Not implemented yet: bug 1430301.
  // sequence<Element> elementsFromPoint (float x, float y);
  // Not implemented yet: bug 1430307.
  // CaretPosition? caretPositionFromPoint (float x, float y);

  readonly attribute Element? activeElement;
  readonly attribute StyleSheetList styleSheets;

  readonly attribute Element? pointerLockElement;
  [LenientSetter, Func="nsIDocument::IsUnprefixedFullscreenEnabled"]
  readonly attribute Element? fullscreenElement;
  [BinaryName="fullscreenElement"]
  readonly attribute Element? mozFullScreenElement;
};
