/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* Portions Copyright Norbert Lindenberg 2011-2012. */

/**
 * Holder object for encapsulating regexp instances.
 *
 * Regular expression instances should be created after the initialization of
 * self-hosted global.
 */
var internalIntlRegExps = std_Object_create(null);
internalIntlRegExps.unicodeLocaleExtensionSequenceRE = null;

/**
 * Regular expression matching a "Unicode locale extension sequence", which the
 * specification defines as: "any substring of a language tag that starts with
 * a separator '-' and the singleton 'u' and includes the maximum sequence of
 * following non-singleton subtags and their preceding '-' separators."
 *
 * Alternatively, this may be defined as: the components of a language tag that
 * match the extension production in RFC 5646, where the singleton component is
 * "u".
 *
 * Spec: ECMAScript Internationalization API Specification, 6.2.1.
 */
function getUnicodeLocaleExtensionSequenceRE() {
    return internalIntlRegExps.unicodeLocaleExtensionSequenceRE ||
           (internalIntlRegExps.unicodeLocaleExtensionSequenceRE =
            RegExpCreate("-u(?:-[a-z0-9]{2,8})+"));
}

/**
 * Removes Unicode locale extension sequences from the given language tag.
 */
function removeUnicodeExtensions(locale) {
    // A wholly-privateuse locale has no extension sequences.
    if (callFunction(std_String_startsWith, locale, "x-"))
        return locale;

    // Otherwise, split on "-x-" marking the start of any privateuse component.
    // Replace Unicode locale extension sequences in the left half, and return
    // the concatenation.
    var pos = callFunction(std_String_indexOf, locale, "-x-");
    if (pos < 0)
        pos = locale.length;

    var left = callFunction(String_substring, locale, 0, pos);
    var right = callFunction(String_substring, locale, pos);

    var unicodeLocaleExtensionSequenceRE = getUnicodeLocaleExtensionSequenceRE();
    var extensions = regexp_exec_no_statics(unicodeLocaleExtensionSequenceRE, left);
    if (extensions !== null) {
        left = callFunction(String_substring, left, 0, extensions.index) +
               callFunction(String_substring, left, extensions.index + extensions[0].length);
    }

    var combined = left + right;
    assert(IsStructurallyValidLanguageTag(combined), "recombination produced an invalid language tag");
    assert(function() {
        var uindex = callFunction(std_String_indexOf, combined, "-u-");
        if (uindex < 0)
            return true;
        var xindex = callFunction(std_String_indexOf, combined, "-x-");
        return xindex > 0 && xindex < uindex;
    }(), "recombination failed to remove all Unicode locale extension sequences");

    return combined;
}

/* eslint-disable complexity */
/**
 * Parser for BCP 47 language tags.
 *
 * Returns null if |locale| can't be parsed as a Language-Tag. If the input is
 * an irregular grandfathered language tag, the object
 *
 *   {
 *     locale: locale.toLowerCase(),
 *     grandfathered: true,
 *   }
 *
 * is returned. Otherwise the returned object has the following structure:
 *
 *   {
 *     locale: locale.toLowerCase(),
 *     language: language subtag without extlang / undefined,
 *     extlang1: first extlang subtag / undefined,
 *     extlang2: second extlang subtag / undefined,
 *     extlang3: third extlang subtag / undefined,
 *     script: script subtag / undefined,
 *     region: region subtag / undefined,
 *     variants: array of variant subtags,
 *     extensions: array of extension subtags,
 *     privateuse: privateuse subtag / undefined,
 *   }
 *
 * All language tag subtags are returned in lower-case:
 *
 *   var langtag = parseLanguageTag("en-Latn-US");
 *   assertEq("en-latn-us", langtag.locale);
 *   assertEq("en", langtag.language);
 *   assertEq("latn", langtag.script);
 *   assertEq("us", langtag.region);
 *
 * Spec: RFC 5646 section 2.1.
 */
function parseLanguageTag(locale) {
    assert(typeof locale === "string", "locale is a string");

    // Current parse index in |locale|.
    var index = 0;

    // The three possible token type bits. Expressed as #defines to avoid
    // extra named lookups in the interpreter/jits.
    #define NONE  0b00
    #define ALPHA 0b01
    #define DIGIT 0b10

    // The current token type, its start index, and its length.
    var token = 0;
    var tokenStart = 0;
    var tokenLength = 0;

    // Constants for code units used below.
    #define HYPHEN  0x2D
    #define DIGIT_ZERO 0x30
    #define DIGIT_NINE 0x39
    #define UPPER_A 0x41
    #define UPPER_Z 0x5A
    #define LOWER_A 0x61
    #define LOWER_X 0x78
    #define LOWER_Z 0x7A
    assert(std_String_fromCharCode(HYPHEN) === "-" &&
           std_String_fromCharCode(DIGIT_ZERO) === "0" &&
           std_String_fromCharCode(DIGIT_NINE) === "9" &&
           std_String_fromCharCode(UPPER_A) === "A" &&
           std_String_fromCharCode(UPPER_Z) === "Z" &&
           std_String_fromCharCode(LOWER_A) === "a" &&
           std_String_fromCharCode(LOWER_X) === "x" &&
           std_String_fromCharCode(LOWER_Z) === "z",
           "code unit constants should match the expected characters");

    // Reads the next token, returns |false| if an illegal character was
    // found, otherwise returns |true|.
    function nextToken() {
        var type = NONE;
        for (var i = index; i < locale.length; i++) {
            // RFC 5234 section B.1
            // ALPHA = %x41-5A / %x61-7A   ; A-Z / a-z
            // DIGIT = %x30-39             ; 0-9
            var c = callFunction(std_String_charCodeAt, locale, i);
            if ((UPPER_A <= c && c <= UPPER_Z) || (LOWER_A <= c && c <= LOWER_Z))
                type |= ALPHA;
            else if (DIGIT_ZERO <= c && c <= DIGIT_NINE)
                type |= DIGIT;
            else if (c === HYPHEN && i > index && i + 1 < locale.length)
                break;
            else
                return false;
        }

        token = type;
        tokenStart = index;
        tokenLength = i - index;
        index = i + 1;
        return true;
    }

    // Language tags are compared and processed case-insensitively, so
    // technically it's not necessary to adjust case. But for easier processing,
    // and because the canonical form for most subtags is lower case, we start
    // with lower case for all.
    //
    // Note that the tokenizer function keeps using the original input string
    // to properly detect non-ASCII characters. The lower-case string can't be
    // used to detect those characters, because some non-ASCII characters
    // lower-case map into ASCII characters, e.g. U+212A (KELVIN SIGN) lower-
    // case maps to U+006B (LATIN SMALL LETTER K).
    var localeLowercase = callFunction(std_String_toLowerCase, locale);

    // Returns the code unit of the first character at the current token
    // position. Always returns the lower-case form of an alphabetical
    // character.
    function tokenStartCodeUnitLower() {
        var c = callFunction(std_String_charCodeAt, localeLowercase, tokenStart);
        assert((DIGIT_ZERO <= c && c <= DIGIT_NINE) || (LOWER_A <= c && c <= LOWER_Z),
               "unexpected code unit");
        return c;
    }

    // Returns the current token part transformed to lower-case.
    function tokenStringLower() {
        return Substring(localeLowercase, tokenStart, tokenLength);
    }

    // Language-Tag = langtag           ; normal language tags
    //              / privateuse        ; private use tag
    //              / grandfathered     ; grandfathered tags
    if (!nextToken())
        return null;

    // All Language-Tag productions start with the ALPHA token and contain
    // less-or-equal to eight characters.
    if (token !== ALPHA || tokenLength > 8)
        return null;

    assert(tokenLength > 0, "token length is not zero if type is ALPHA");

    var language, extlang1, extlang2, extlang3, script, region, privateuse;
    var variants = [];
    var extensions = [];

    // langtag = language
    //           ["-" script]
    //           ["-" region]
    //           *("-" variant)
    //           *("-" extension)
    //           ["-" privateuse]
    if (tokenLength > 1) {
        // language = 2*3ALPHA          ; shortest ISO 639 code
        //            ["-" extlang]     ; sometimes followed by
        //                              ; extended language subtags
        //          / 4ALPHA            ; or reserved for future use
        //          / 5*8ALPHA          ; or registered language subtag
        if (tokenLength <= 3) {
            language = tokenStringLower();
            if (!nextToken())
                return null;

            // extlang = 3ALPHA         ; selected ISO 639 codes
            //           *2("-" 3ALPHA) ; permanently reserved
            if (token === ALPHA && tokenLength === 3) {
                extlang1 = tokenStringLower();
                if (!nextToken())
                    return null;
                if (token === ALPHA && tokenLength === 3) {
                    extlang2 = tokenStringLower();
                    if (!nextToken())
                        return null;
                    if (token === ALPHA && tokenLength === 3) {
                        extlang3 = tokenStringLower();
                        if (!nextToken())
                            return null;
                    }
                }
            }
        } else {
            assert(4 <= tokenLength && tokenLength <= 8, "reserved/registered language subtags");
            language = tokenStringLower();
            if (!nextToken())
                return null;
        }

        // script = 4ALPHA              ; ISO 15924 code
        if (tokenLength === 4 && token === ALPHA) {
            script = tokenStringLower();
            if (!nextToken())
                return null;
        }

        // region = 2ALPHA              ; ISO 3166-1 code
        //        / 3DIGIT              ; UN M.49 code
        if ((tokenLength === 2 && token === ALPHA) || (tokenLength === 3 && token === DIGIT)) {
            region = tokenStringLower();
            if (!nextToken())
                return null;
        }

        // variant = 5*8alphanum        ; registered variants
        //         / (DIGIT 3alphanum)
        //
        // RFC 5646 section 2.1
        // alphanum = (ALPHA / DIGIT)   ; letters and numbers
        while ((5 <= tokenLength && tokenLength <= 8) ||
               (tokenLength === 4 && tokenStartCodeUnitLower() <= DIGIT_NINE))
        {
            assert(!(tokenStartCodeUnitLower() <= DIGIT_NINE) ||
                   tokenStartCodeUnitLower() >= DIGIT_ZERO,
                   "token-start-code-unit <= '9' implies token-start-code-unit is in '0'..'9'");

            // Language tags are case insensitive (RFC 5646 section 2.1.1).
            // All seen variants are compared ignoring case differences by
            // using the lower-case form. This allows to properly detect and
            // reject variant repetitions with differing case, e.g.
            // "en-variant-Variant".
            var variant = tokenStringLower();

            // Reject the language tag if a duplicate variant was found.
            //
            // This linear-time verification step means the whole variant
            // subtag checking is potentially quadratic, but we're okay doing
            // that because language tags are unlikely to be deliberately
            // pathological.
            if (callFunction(ArrayIndexOf, variants, variant) !== -1)
                return null;
            _DefineDataProperty(variants, variants.length, variant);

            if (!nextToken())
                return null;
        }

        // extension = singleton 1*("-" (2*8alphanum))
        // singleton = DIGIT            ; 0 - 9
        //           / %x41-57          ; A - W
        //           / %x59-5A          ; Y - Z
        //           / %x61-77          ; a - w
        //           / %x79-7A          ; y - z
        var seenSingletons = [];
        while (tokenLength === 1) {
            var extensionStart = tokenStart;
            var singleton = tokenStartCodeUnitLower();
            if (singleton === LOWER_X)
                break;

            // Language tags are case insensitive (RFC 5646 section 2.1.1).
            // Ensure |tokenStartCodeUnitLower()| does not return the code
            // unit of an upper-case character, so we can properly detect and
            // reject language tags with different case, e.g. "en-u-foo-U-foo".
            assert(!(UPPER_A <= singleton && singleton <= UPPER_Z),
                   "unexpected upper-case code unit");

            // Reject the input if a duplicate singleton was found.
            //
            // Similar to the variant validation step this check is O(n**2),
            // but given that there are only 35 possible singletons the
            // quadratic runtime is negligible.
            if (callFunction(ArrayIndexOf, seenSingletons, singleton) !== -1)
                return null;
            _DefineDataProperty(seenSingletons, seenSingletons.length, singleton);

            if (!nextToken())
                return null;

            if (!(2 <= tokenLength && tokenLength <= 8))
                return null;
            do {
                if (!nextToken())
                    return null;
            } while (2 <= tokenLength && tokenLength <= 8);

            var extension = Substring(localeLowercase, extensionStart,
                                      (tokenStart - 1 - extensionStart));
            _DefineDataProperty(extensions, extensions.length, extension);
        }
    }

    // Either trailing privateuse component of the langtag production or
    // standalone privateuse tag.
    //
    // privateuse = "x" 1*("-" (1*8alphanum))
    if (tokenLength === 1 && tokenStartCodeUnitLower() === LOWER_X) {
        var privateuseStart = tokenStart;
        if (!nextToken())
            return null;

        if (!(1 <= tokenLength && tokenLength <= 8))
            return null;
        do {
            if (!nextToken())
                return null;
        } while (1 <= tokenLength && tokenLength <= 8);

        privateuse = Substring(localeLowercase, privateuseStart,
                               localeLowercase.length - privateuseStart);
    }

    // Return if the complete input was successfully parsed. That means it is
    // either a langtag or privateuse-only language tag, or it is a regular
    // grandfathered language tag.
    if (token === NONE) {
        return {
            locale: localeLowercase,
            language,
            extlang1,
            extlang2,
            extlang3,
            script,
            region,
            variants,
            extensions,
            privateuse,
        };
    }

    // Before we can compare the lower-case form of locale to the list of
    // grandfathered language tags, we need to ensure any remaining parts are
    // alphanum-only ASCII characters. This step is necessary because locale
    // could include other characters which lower-case map into ASCII
    // characters.
    // For example we need to reject "i-ha\u212A" (U+212A KELVIN SIGN) even
    // though its lower-case form "i-hak" matches a grandfathered language
    // tag.
    do {
        if (!nextToken())
            return null;
    } while (token !== NONE);

    // grandfathered = irregular        ; non-redundant tags registered
    //               / regular          ; during the RFC 3066 era
    switch (localeLowercase) {
#ifdef DEBUG
      // regular = "art-lojban"         ; these tags match the 'langtag'
      //         / "cel-gaulish"        ; production, but their subtags
      //         / "no-bok"             ; are not extended language
      //         / "no-nyn"             ; or variant subtags: their meaning
      //         / "zh-guoyu"           ; is defined by their registration
      //         / "zh-hakka"           ; and all of these are deprecated
      //         / "zh-min"             ; in favor of a more modern
      //         / "zh-min-nan"         ; subtag or sequence of subtags
      //         / "zh-xiang"
      case "art-lojban":
      case "cel-gaulish":
      case "no-bok":
      case "no-nyn":
      case "zh-guoyu":
      case "zh-hakka":
      case "zh-min":
      case "zh-min-nan":
      case "zh-xiang":
        assert(false, "regular grandfathered tags should have been matched above");
#endif /* DEBUG */

      // irregular = "en-GB-oed"        ; irregular tags do not match
      //           / "i-ami"            ; the 'langtag' production and
      //           / "i-bnn"            ; would not otherwise be
      //           / "i-default"        ; considered 'well-formed'
      //           / "i-enochian"       ; These tags are all valid,
      //           / "i-hak"            ; but most are deprecated
      //           / "i-klingon"        ; in favor of more modern
      //           / "i-lux"            ; subtags or subtag
      //           / "i-mingo"          ; combination
      //           / "i-navajo"
      //           / "i-pwn"
      //           / "i-tao"
      //           / "i-tay"
      //           / "i-tsu"
      //           / "sgn-BE-FR"
      //           / "sgn-BE-NL"
      //           / "sgn-CH-DE"
      case "en-gb-oed":
      case "i-ami":
      case "i-bnn":
      case "i-default":
      case "i-enochian":
      case "i-hak":
      case "i-klingon":
      case "i-lux":
      case "i-mingo":
      case "i-navajo":
      case "i-pwn":
      case "i-tao":
      case "i-tay":
      case "i-tsu":
      case "sgn-be-fr":
      case "sgn-be-nl":
      case "sgn-ch-de":
        return { locale: localeLowercase, grandfathered: true };

      default:
        return null;
    }

    #undef NONE
    #undef ALPHA
    #undef DIGIT
    #undef HYPHEN
    #undef DIGIT_ZERO
    #undef DIGIT_NINE
    #undef UPPER_A
    #undef UPPER_Z
    #undef LOWER_A
    #undef LOWER_X
    #undef LOWER_Z
}
/* eslint-enable complexity */

/**
 * Verifies that the given string is a well-formed BCP 47 language tag
 * with no duplicate variant or singleton subtags.
 *
 * Spec: ECMAScript Internationalization API Specification, 6.2.2.
 */
function IsStructurallyValidLanguageTag(locale) {
    return parseLanguageTag(locale) !== null;
}

/**
 * Canonicalizes the given structurally valid BCP 47 language tag, including
 * regularized case of subtags. For example, the language tag
 * Zh-NAN-haNS-bu-variant2-Variant1-u-ca-chinese-t-Zh-laTN-x-PRIVATE, where
 *
 *     Zh             ; 2*3ALPHA
 *     -NAN           ; ["-" extlang]
 *     -haNS          ; ["-" script]
 *     -bu            ; ["-" region]
 *     -variant2      ; *("-" variant)
 *     -Variant1
 *     -u-ca-chinese  ; *("-" extension)
 *     -t-Zh-laTN
 *     -x-PRIVATE     ; ["-" privateuse]
 *
 * becomes nan-Hans-mm-variant2-variant1-t-zh-latn-u-ca-chinese-x-private
 *
 * Spec: ECMAScript Internationalization API Specification, 6.2.3.
 * Spec: RFC 5646, section 4.5.
 */
function CanonicalizeLanguageTagFromObject(localeObj) {
    assert(IsObject(localeObj), "CanonicalizeLanguageTagFromObject");

    var {locale} = localeObj;
    assert(locale === callFunction(std_String_toLowerCase, locale),
           "expected lower-case form for locale string");

    // Handle mappings for complete tags.
    if (hasOwn(locale, langTagMappings))
        return langTagMappings[locale];

    assert(!hasOwn("grandfathered", localeObj),
           "grandfathered tags should be mapped completely");

    var {
        language,
        extlang1,
        extlang2,
        extlang3,
        script,
        region,
        variants,
        extensions,
        privateuse,
    } = localeObj;

    // Be careful of a Language-Tag that is entirely privateuse.
    if (!language) {
        assert(typeof privateuse === "string", "language or privateuse subtag required");
        return privateuse;
    }

    // Replace deprecated language tags with their preferred values.
    // "in" -> "id"
    if (hasOwn(language, languageMappings))
        language = languageMappings[language];

    var canonical = language;

    if (extlang1) {
        // When an extlang subtag is encountered with its corresponding
        // primary language tag prefix, replace the combination with the
        // preferred value -- which MUST be the unadorned extlang subtag.
        // For example, this entry
        //
        //   Type: extlang
        //   Subtag: nan
        //   Description: Min Nan Chinese
        //   Added: 2009-07-29
        //   Preferred-Value: nan
        //   Prefix: zh
        //   Macrolanguage: zh
        //
        // is interpreted to say that if a "nan" extlang appears after a "zh"
        // primary language prefix, the extlang and its prefix must be
        // replaced by its preferred value, so "zh-nan" must be replaced by
        // the preferred value "nan". (RFC 5646 section 2.2.2)
        if (hasOwn(extlang1, extlangMappings) && extlangMappings[extlang1] === language)
            canonical = extlang1;
        else
            canonical += "-" + extlang1;
    }

    // The second extlang subtag will always be left as is.
    // (RFC 5646 section 2.2.2)
    if (extlang2)
        canonical += "-" + extlang2;

    // The third extlang subtag will always be left as is.
    // (RFC 5646 section 2.2.2)
    if (extlang3)
        canonical += "-" + extlang3;

    if (script) {
        // The first character of a script code needs to be capitalized.
        // "hans" -> "Hans"
        script = callFunction(std_String_toUpperCase, script[0]) +
                 Substring(script, 1, script.length - 1);

        // No script replacements are currently present, so append as is.
        canonical += "-" + script;
    }

    if (region) {
        // Region codes need to be in upper-case. "bu" -> "BU"
        region = callFunction(std_String_toUpperCase, region);

        // Replace deprecated subtags with their preferred values.
        // "BU" -> "MM"
        if (hasOwn(region, regionMappings))
            region = regionMappings[region];

        canonical += "-" + region;
    }

    // No variant replacements are currently present, so append as is.
    if (variants.length > 0)
        canonical += "-" + callFunction(std_Array_join, variants, "-");

    if (extensions.length > 0) {
        // Extension sequences are sorted by their singleton characters.
        // "u-ca-chinese-t-zh-latn" -> "t-zh-latn-u-ca-chinese"
        callFunction(ArraySort, extensions);

        canonical += "-" + callFunction(std_Array_join, extensions, "-");
    }

    // Private use sequences are left as is. "x-private"
    if (privateuse)
        canonical += "-" + privateuse;

    return canonical;
}

/**
 * Canonicalizes the given structurally valid BCP 47 language tag, including
 * regularized case of subtags. For example, the language tag
 * Zh-NAN-haNS-bu-variant2-Variant1-u-ca-chinese-t-Zh-laTN-x-PRIVATE, where
 *
 *     Zh             ; 2*3ALPHA
 *     -NAN           ; ["-" extlang]
 *     -haNS          ; ["-" script]
 *     -bu            ; ["-" region]
 *     -variant2      ; *("-" variant)
 *     -Variant1
 *     -u-ca-chinese  ; *("-" extension)
 *     -t-Zh-laTN
 *     -x-PRIVATE     ; ["-" privateuse]
 *
 * becomes nan-Hans-mm-variant2-variant1-t-zh-latn-u-ca-chinese-x-private
 *
 * Spec: ECMAScript Internationalization API Specification, 6.2.3.
 * Spec: RFC 5646, section 4.5.
 */
function CanonicalizeLanguageTag(locale) {
    var localeObj = parseLanguageTag(locale);
    assert(localeObj !== null, "CanonicalizeLanguageTag");

    return CanonicalizeLanguageTagFromObject(localeObj);
}

/**
 * Returns true if the input contains only ASCII alphabetical characters.
 */
function IsASCIIAlphaString(s) {
    assert(typeof s === "string", "IsASCIIAlphaString");

    for (var i = 0; i < s.length; i++) {
        var c = callFunction(std_String_charCodeAt, s, i);
        if (!((0x41 <= c && c <= 0x5A) || (0x61 <= c && c <= 0x7A)))
            return false;
    }
    return true;
}

/**
 * Validates and canonicalizes the given language tag.
 */
function ValidateAndCanonicalizeLanguageTag(locale) {
    assert(typeof locale === "string", "ValidateAndCanonicalizeLanguageTag");

    // Handle the common case (a standalone language) first.
    // Only the following BCP47 subset is accepted:
    //   Language-Tag  = langtag
    //   langtag       = language
    //   language      = 2*3ALPHA ; shortest ISO 639 code
    // For three character long strings we need to make sure it's not a
    // private use only language tag, for example "x-x".
    if (locale.length === 2 || (locale.length === 3 && locale[1] !== "-")) {
        if (!IsASCIIAlphaString(locale))
            ThrowRangeError(JSMSG_INVALID_LANGUAGE_TAG, locale);
        assert(IsStructurallyValidLanguageTag(locale), "2*3ALPHA is a valid language tag");

        // The language subtag is canonicalized to lower case.
        locale = callFunction(std_String_toLowerCase, locale);

        // langTagMappings doesn't contain any 2*3ALPHA keys, so we don't need
        // to check for possible replacements in this map.
        assert(!hasOwn(locale, langTagMappings), "langTagMappings contains no 2*3ALPHA mappings");

        // Replace deprecated subtags with their preferred values.
        locale = hasOwn(locale, languageMappings)
                 ? languageMappings[locale]
                 : locale;
        assert(locale === CanonicalizeLanguageTag(locale), "expected same canonicalization");

        return locale;
    }

    var localeObj = parseLanguageTag(locale);
    if (localeObj === null)
        ThrowRangeError(JSMSG_INVALID_LANGUAGE_TAG, locale);

    return CanonicalizeLanguageTagFromObject(localeObj);
}

function localeContainsNoUnicodeExtensions(locale) {
    // No "-u-", no possible Unicode extension.
    if (callFunction(std_String_indexOf, locale, "-u-") === -1)
        return true;

    // "-u-" within privateuse also isn't one.
    if (callFunction(std_String_indexOf, locale, "-u-") > callFunction(std_String_indexOf, locale, "-x-"))
        return true;

    // An entirely-privateuse tag doesn't contain extensions.
    if (callFunction(std_String_startsWith, locale, "x-"))
        return true;

    // Otherwise, we have a Unicode extension sequence.
    return false;
}

// The last-ditch locale is used if none of the available locales satisfies a
// request. "en-GB" is used based on the assumptions that English is the most
// common second language, that both en-GB and en-US are normally available in
// an implementation, and that en-GB is more representative of the English used
// in other locales.
function lastDitchLocale() {
    // Per bug 1177929, strings don't clone out of self-hosted code as atoms,
    // breaking IonBuilder::constant.  Put this in a function for now.
    return "en-GB";
}

// Certain old, commonly-used language tags that lack a script, are expected to
// nonetheless imply one.  This object maps these old-style tags to modern
// equivalents.
var oldStyleLanguageTagMappings = {
    "pa-PK": "pa-Arab-PK",
    "zh-CN": "zh-Hans-CN",
    "zh-HK": "zh-Hant-HK",
    "zh-SG": "zh-Hans-SG",
    "zh-TW": "zh-Hant-TW",
};

var localeCandidateCache = {
    runtimeDefaultLocale: undefined,
    candidateDefaultLocale: undefined,
};

var localeCache = {
    runtimeDefaultLocale: undefined,
    defaultLocale: undefined,
};

/**
 * Compute the candidate default locale: the locale *requested* to be used as
 * the default locale.  We'll use it if and only if ICU provides support (maybe
 * fallback support, e.g. supporting "de-ZA" through "de" support implied by a
 * "de-DE" locale).
 */
function DefaultLocaleIgnoringAvailableLocales() {
    const runtimeDefaultLocale = RuntimeDefaultLocale();
    if (runtimeDefaultLocale === localeCandidateCache.runtimeDefaultLocale)
        return localeCandidateCache.candidateDefaultLocale;

    // If we didn't get a cache hit, compute the candidate default locale and
    // cache it.  Fall back on the last-ditch locale when necessary.
    var candidate = parseLanguageTag(runtimeDefaultLocale);
    if (candidate === null) {
        candidate = lastDitchLocale();
    } else {
        candidate = CanonicalizeLanguageTagFromObject(candidate);

        // The default locale must be in [[availableLocales]], and that list
        // must not contain any locales with Unicode extension sequences, so
        // remove any present in the candidate.
        candidate = removeUnicodeExtensions(candidate);

        if (hasOwn(candidate, oldStyleLanguageTagMappings))
            candidate = oldStyleLanguageTagMappings[candidate];
    }

    // Cache the candidate locale until the runtime default locale changes.
    localeCandidateCache.candidateDefaultLocale = candidate;
    localeCandidateCache.runtimeDefaultLocale = runtimeDefaultLocale;

    assert(IsStructurallyValidLanguageTag(candidate),
           "the candidate must be structurally valid");
    assert(localeContainsNoUnicodeExtensions(candidate),
           "the candidate must not contain a Unicode extension sequence");

    return candidate;
}

/**
 * Returns the BCP 47 language tag for the host environment's current locale.
 *
 * Spec: ECMAScript Internationalization API Specification, 6.2.4.
 */
function DefaultLocale() {
    if (IsRuntimeDefaultLocale(localeCache.runtimeDefaultLocale))
        return localeCache.defaultLocale;

    // If we didn't have a cache hit, compute the candidate default locale.
    // Then use it as the actual default locale if ICU supports that locale
    // (perhaps via fallback).  Otherwise use the last-ditch locale.
    var runtimeDefaultLocale = RuntimeDefaultLocale();
    var candidate = DefaultLocaleIgnoringAvailableLocales();
    var locale;
    if (BestAvailableLocaleIgnoringDefault(callFunction(collatorInternalProperties.availableLocales,
                                                        collatorInternalProperties),
                                           candidate) &&
        BestAvailableLocaleIgnoringDefault(callFunction(numberFormatInternalProperties.availableLocales,
                                                        numberFormatInternalProperties),
                                           candidate) &&
        BestAvailableLocaleIgnoringDefault(callFunction(dateTimeFormatInternalProperties.availableLocales,
                                                        dateTimeFormatInternalProperties),
                                           candidate))
    {
        locale = candidate;
    } else {
        locale = lastDitchLocale();
    }

    assert(IsStructurallyValidLanguageTag(locale),
           "the computed default locale must be structurally valid");
    assert(locale === CanonicalizeLanguageTag(locale),
           "the computed default locale must be canonical");
    assert(localeContainsNoUnicodeExtensions(locale),
           "the computed default locale must not contain a Unicode extension sequence");

    localeCache.defaultLocale = locale;
    localeCache.runtimeDefaultLocale = runtimeDefaultLocale;

    return locale;
}

/**
 * Add old-style language tags without script code for locales that in current
 * usage would include a script subtag.  Also add an entry for the last-ditch
 * locale, in case ICU doesn't directly support it (but does support it through
 * fallback, e.g. supporting "en-GB" indirectly using "en" support).
 */
function addSpecialMissingLanguageTags(availableLocales) {
    // Certain old-style language tags lack a script code, but in current usage
    // they *would* include a script code.  Map these over to modern forms.
    var oldStyleLocales = std_Object_getOwnPropertyNames(oldStyleLanguageTagMappings);
    for (var i = 0; i < oldStyleLocales.length; i++) {
        var oldStyleLocale = oldStyleLocales[i];
        if (availableLocales[oldStyleLanguageTagMappings[oldStyleLocale]])
            availableLocales[oldStyleLocale] = true;
    }

    // Also forcibly provide the last-ditch locale.
    var lastDitch = lastDitchLocale();
    assert(lastDitch === "en-GB" && availableLocales.en,
           "shouldn't be a need to add every locale implied by the last-" +
           "ditch locale, merely just the last-ditch locale");
    availableLocales[lastDitch] = true;
}

/**
 * Canonicalizes a locale list.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.1.
 */
function CanonicalizeLocaleList(locales) {
    if (locales === undefined)
        return [];
    if (typeof locales === "string")
        return [ValidateAndCanonicalizeLanguageTag(locales)];
    var seen = [];
    var O = ToObject(locales);
    var len = ToLength(O.length);
    var k = 0;
    while (k < len) {
        // Don't call ToString(k) - SpiderMonkey is faster with integers.
        var kPresent = HasProperty(O, k);
        if (kPresent) {
            var kValue = O[k];
            if (!(typeof kValue === "string" || IsObject(kValue)))
                ThrowTypeError(JSMSG_INVALID_LOCALES_ELEMENT);
            var tag = ToString(kValue);
            tag = ValidateAndCanonicalizeLanguageTag(tag);
            if (callFunction(ArrayIndexOf, seen, tag) === -1)
                _DefineDataProperty(seen, seen.length, tag);
        }
        k++;
    }
    return seen;
}

function BestAvailableLocaleHelper(availableLocales, locale, considerDefaultLocale) {
    assert(IsStructurallyValidLanguageTag(locale), "invalid BestAvailableLocale locale structure");
    assert(locale === CanonicalizeLanguageTag(locale), "non-canonical BestAvailableLocale locale");
    assert(localeContainsNoUnicodeExtensions(locale), "locale must contain no Unicode extensions");

    // In the spec, [[availableLocales]] is formally a list of all available
    // locales.  But in our implementation, it's an *incomplete* list, not
    // necessarily including the default locale (and all locales implied by it,
    // e.g. "de" implied by "de-CH"), if that locale isn't in every
    // [[availableLocales]] list (because that locale is supported through
    // fallback, e.g. "de-CH" supported through "de").
    //
    // If we're considering the default locale, augment the spec loop with
    // additional checks to also test whether the current prefix is a prefix of
    // the default locale.

    var defaultLocale;
    if (considerDefaultLocale)
        defaultLocale = DefaultLocale();

    var candidate = locale;
    while (true) {
        if (availableLocales[candidate])
            return candidate;

        if (considerDefaultLocale && candidate.length <= defaultLocale.length) {
            if (candidate === defaultLocale)
                return candidate;
            if (callFunction(std_String_startsWith, defaultLocale, candidate + "-"))
                return candidate;
        }

        var pos = callFunction(std_String_lastIndexOf, candidate, "-");
        if (pos === -1)
            return undefined;

        if (pos >= 2 && candidate[pos - 2] === "-")
            pos -= 2;

        candidate = callFunction(String_substring, candidate, 0, pos);
    }
}

/**
 * Compares a BCP 47 language tag against the locales in availableLocales
 * and returns the best available match. Uses the fallback
 * mechanism of RFC 4647, section 3.4.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.2.
 * Spec: RFC 4647, section 3.4.
 */
function BestAvailableLocale(availableLocales, locale) {
    return BestAvailableLocaleHelper(availableLocales, locale, true);
}

/**
 * Identical to BestAvailableLocale, but does not consider the default locale
 * during computation.
 */
function BestAvailableLocaleIgnoringDefault(availableLocales, locale) {
    return BestAvailableLocaleHelper(availableLocales, locale, false);
}

/**
 * Compares a BCP 47 language priority list against the set of locales in
 * availableLocales and determines the best available language to meet the
 * request. Options specified through Unicode extension subsequences are
 * ignored in the lookup, but information about such subsequences is returned
 * separately.
 *
 * This variant is based on the Lookup algorithm of RFC 4647 section 3.4.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.3.
 * Spec: RFC 4647, section 3.4.
 */
function LookupMatcher(availableLocales, requestedLocales) {
    var i = 0;
    var len = requestedLocales.length;
    var availableLocale;
    var locale, noExtensionsLocale;
    while (i < len && availableLocale === undefined) {
        locale = requestedLocales[i];
        noExtensionsLocale = removeUnicodeExtensions(locale);
        availableLocale = BestAvailableLocale(availableLocales, noExtensionsLocale);
        i++;
    }

    var result = new Record();
    if (availableLocale !== undefined) {
        result.locale = availableLocale;
        if (locale !== noExtensionsLocale) {
            var unicodeLocaleExtensionSequenceRE = getUnicodeLocaleExtensionSequenceRE();
            var extensionMatch = regexp_exec_no_statics(unicodeLocaleExtensionSequenceRE, locale);
            result.extension = extensionMatch[0];
        }
    } else {
        result.locale = DefaultLocale();
    }
    return result;
}

/**
 * Compares a BCP 47 language priority list against the set of locales in
 * availableLocales and determines the best available language to meet the
 * request. Options specified through Unicode extension subsequences are
 * ignored in the lookup, but information about such subsequences is returned
 * separately.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.4.
 */
function BestFitMatcher(availableLocales, requestedLocales) {
    // this implementation doesn't have anything better
    return LookupMatcher(availableLocales, requestedLocales);
}

/**
 * Returns the Unicode extension value subtags for the requested key subtag.
 *
 * NOTE: PR to add UnicodeExtensionValue to ECMA-402 isn't yet written.
 */
function UnicodeExtensionValue(extension, key) {
    assert(typeof extension === "string", "extension is a string value");
    assert(function() {
        var unicodeLocaleExtensionSequenceRE = getUnicodeLocaleExtensionSequenceRE();
        var extensionMatch = regexp_exec_no_statics(unicodeLocaleExtensionSequenceRE, extension);
        return extensionMatch !== null && extensionMatch[0] === extension;
    }(), "extension is a Unicode extension subtag");
    assert(typeof key === "string", "key is a string value");
    assert(key.length === 2, "key is a Unicode extension key subtag");

    // Step 1.
    var size = extension.length;

    // Step 2.
    var searchValue = "-" + key + "-";

    // Step 3.
    var pos = callFunction(std_String_indexOf, extension, searchValue);

    // Step 4.
    if (pos !== -1) {
        // Step 4.a.
        var start = pos + 4;

        // Step 4.b.
        var end = start;

        // Step 4.c.
        var k = start;

        // Steps 4.d-e.
        while (true) {
            // Step 4.e.i.
            var e = callFunction(std_String_indexOf, extension, "-", k);

            // Step 4.e.ii.
            var len = e === -1 ? size - k : e - k;

            // Step 4.e.iii.
            if (len === 2)
                break;

            // Step 4.e.iv.
            if (e === -1) {
                end = size;
                break;
            }

            // Step 4.e.v.
            end = e;
            k = e + 1;
        }

        // Step 4.f.
        return callFunction(String_substring, extension, start, end);
    }

    // Step 5.
    searchValue = "-" + key;

    // Steps 6-7.
    if (callFunction(std_String_endsWith, extension, searchValue))
        return "";

    // Step 8 (implicit).
}

/**
 * Compares a BCP 47 language priority list against availableLocales and
 * determines the best available language to meet the request. Options specified
 * through Unicode extension subsequences are negotiated separately, taking the
 * caller's relevant extensions and locale data as well as client-provided
 * options into consideration.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.5.
 */
function ResolveLocale(availableLocales, requestedLocales, options, relevantExtensionKeys, localeData) {
    /*jshint laxbreak: true */

    // Steps 1-3.
    var matcher = options.localeMatcher;
    var r = (matcher === "lookup")
            ? LookupMatcher(availableLocales, requestedLocales)
            : BestFitMatcher(availableLocales, requestedLocales);

    // Step 4.
    var foundLocale = r.locale;

    // Step 5 (Not applicable in this implementation).
    var extension = r.extension;

    // Steps 6-7.
    var result = new Record();
    result.dataLocale = foundLocale;

    // Step 8.
    var supportedExtension = "-u";

    // In this implementation, localeData is a function, not an object.
    var localeDataProvider = localeData();

    // Steps 9-12.
    for (var i = 0; i < relevantExtensionKeys.length; i++) {
        // Step 12.a.
        var key = relevantExtensionKeys[i];

        // Steps 12.b-d (The locale data is only computed when needed).
        var keyLocaleData = undefined;
        var value = undefined;

        // Locale tag may override.

        // Step 12.e.
        var supportedExtensionAddition = "";

        // Step 12.f.
        if (extension !== undefined) {
            // NB: The step annotations don't yet match the ES2017 Intl draft,
            // 94045d234762ad107a3d09bb6f7381a65f1a2f9b, because the PR to add
            // the new UnicodeExtensionValue abstract operation still needs to
            // be written.

            // Step 12.f.i.
            var requestedValue = UnicodeExtensionValue(extension, key);

            // Step 12.f.ii.
            if (requestedValue !== undefined) {
                // Steps 12.b-c.
                keyLocaleData = callFunction(localeDataProvider[key], null, foundLocale);

                // Step 12.f.ii.1.
                if (requestedValue !== "") {
                    // Step 12.f.ii.1.a.
                    if (callFunction(ArrayIndexOf, keyLocaleData, requestedValue) !== -1) {
                        value = requestedValue;
                        supportedExtensionAddition = "-" + key + "-" + value;
                    }
                } else {
                    // Step 12.f.ii.2.

                    // According to the LDML spec, if there's no type value,
                    // and true is an allowed value, it's used.
                    if (callFunction(ArrayIndexOf, keyLocaleData, "true") !== -1)
                        value = "true";
                }
            }
        }

        // Options override all.

        // Step 12.g.i.
        var optionsValue = options[key];

        // Step 12.g, 12.g.ii.
        if (optionsValue !== undefined && optionsValue !== value) {
            // Steps 12.b-c.
            if (keyLocaleData === undefined)
                keyLocaleData = callFunction(localeDataProvider[key], null, foundLocale);

            if (callFunction(ArrayIndexOf, keyLocaleData, optionsValue) !== -1) {
                value = optionsValue;
                supportedExtensionAddition = "";
            }
        }

        // Locale data provides default value.
        if (value === undefined) {
            // Steps 12.b-d.
            value = keyLocaleData === undefined
                    ? callFunction(localeDataProvider.default[key], null, foundLocale)
                    : keyLocaleData[0];
        }

        // Steps 12.h-j.
        assert(typeof value === "string" || value === null, "unexpected locale data value");
        result[key] = value;
        supportedExtension += supportedExtensionAddition;
    }

    // Step 13.
    if (supportedExtension.length > 2) {
        assert(!callFunction(std_String_startsWith, foundLocale, "x-"),
               "unexpected privateuse-only locale returned from ICU");

        // Step 13.a.
        var privateIndex = callFunction(std_String_indexOf, foundLocale, "-x-");

        // Steps 13.b-c.
        if (privateIndex === -1) {
            foundLocale += supportedExtension;
        } else {
            var preExtension = callFunction(String_substring, foundLocale, 0, privateIndex);
            var postExtension = callFunction(String_substring, foundLocale, privateIndex);
            foundLocale = preExtension + supportedExtension + postExtension;
        }

        // Step 13.d.
        assert(IsStructurallyValidLanguageTag(foundLocale), "invalid locale after concatenation");

        // Step 13.e (Not required in this implementation, because we don't
        // canonicalize Unicode extension subtags).
        assert(foundLocale === CanonicalizeLanguageTag(foundLocale), "same locale with extension");
    }

    // Step 14.
    result.locale = foundLocale;

    // Step 15.
    return result;
}

/**
 * Returns the subset of requestedLocales for which availableLocales has a
 * matching (possibly fallback) locale. Locales appear in the same order in the
 * returned list as in the input list.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.6.
 */
function LookupSupportedLocales(availableLocales, requestedLocales) {
    // Steps 1-2.
    var len = requestedLocales.length;
    var subset = [];

    // Steps 3-4.
    var k = 0;
    while (k < len) {
        // Steps 4.a-b.
        var locale = requestedLocales[k];
        var noExtensionsLocale = removeUnicodeExtensions(locale);

        // Step 4.c-d.
        var availableLocale = BestAvailableLocale(availableLocales, noExtensionsLocale);
        if (availableLocale !== undefined)
            _DefineDataProperty(subset, subset.length, locale);

        // Step 4.e.
        k++;
    }

    // Steps 5-6.
    return subset;
}

/**
 * Returns the subset of requestedLocales for which availableLocales has a
 * matching (possibly fallback) locale. Locales appear in the same order in the
 * returned list as in the input list.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.7.
 */
function BestFitSupportedLocales(availableLocales, requestedLocales) {
    // don't have anything better
    return LookupSupportedLocales(availableLocales, requestedLocales);
}

/**
 * Returns the subset of requestedLocales for which availableLocales has a
 * matching (possibly fallback) locale. Locales appear in the same order in the
 * returned list as in the input list.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.8.
 */
function SupportedLocales(availableLocales, requestedLocales, options) {
    /*jshint laxbreak: true */

    // Step 1.
    var matcher;
    if (options !== undefined) {
        // Steps 1.a-b.
        options = ToObject(options);
        matcher = options.localeMatcher;

        // Step 1.c.
        if (matcher !== undefined) {
            matcher = ToString(matcher);
            if (matcher !== "lookup" && matcher !== "best fit")
                ThrowRangeError(JSMSG_INVALID_LOCALE_MATCHER, matcher);
        }
    }

    // Steps 2-3.
    var subset = (matcher === undefined || matcher === "best fit")
                 ? BestFitSupportedLocales(availableLocales, requestedLocales)
                 : LookupSupportedLocales(availableLocales, requestedLocales);

    // Step 4.
    for (var i = 0; i < subset.length; i++) {
        _DefineDataProperty(subset, i, subset[i],
                            ATTR_ENUMERABLE | ATTR_NONCONFIGURABLE | ATTR_NONWRITABLE);
    }
    _DefineDataProperty(subset, "length", subset.length,
                        ATTR_NONENUMERABLE | ATTR_NONCONFIGURABLE | ATTR_NONWRITABLE);

    // Step 5.
    return subset;
}

/**
 * Extracts a property value from the provided options object, converts it to
 * the required type, checks whether it is one of a list of allowed values,
 * and fills in a fallback value if necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.9.
 */
function GetOption(options, property, type, values, fallback) {
    // Step 1.
    var value = options[property];

    // Step 2.
    if (value !== undefined) {
        // Steps 2.a-c.
        if (type === "boolean")
            value = ToBoolean(value);
        else if (type === "string")
            value = ToString(value);
        else
            assert(false, "GetOption");

        // Step 2.d.
        if (values !== undefined && callFunction(ArrayIndexOf, values, value) === -1)
            ThrowRangeError(JSMSG_INVALID_OPTION_VALUE, property, value);

        // Step 2.e.
        return value;
    }

    // Step 3.
    return fallback;
}

/**
 * The abstract operation DefaultNumberOption converts value to a Number value,
 * checks whether it is in the allowed range, and fills in a fallback value if
 * necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.11.
 */
function DefaultNumberOption(value, minimum, maximum, fallback) {
    assert(typeof minimum === "number" && (minimum | 0) === minimum, "DefaultNumberOption");
    assert(typeof maximum === "number" && (maximum | 0) === maximum, "DefaultNumberOption");
    assert(typeof fallback === "number" && (fallback | 0) === fallback, "DefaultNumberOption");
    assert(minimum <= fallback && fallback <= maximum, "DefaultNumberOption");

    // Step 1.
    if (value !== undefined) {
        value = ToNumber(value);
        if (Number_isNaN(value) || value < minimum || value > maximum)
            ThrowRangeError(JSMSG_INVALID_DIGITS_VALUE, value);

        // Apply bitwise-or to convert -0 to +0 per ES2017, 5.2 and to ensure
        // the result is an int32 value.
        return std_Math_floor(value) | 0;
    }

    // Step 2.
    return fallback;
}

/**
 * Extracts a property value from the provided options object, converts it to a
 * Number value, checks whether it is in the allowed range, and fills in a
 * fallback value if necessary.
 *
 * Spec: ECMAScript Internationalization API Specification, 9.2.12.
 */
function GetNumberOption(options, property, minimum, maximum, fallback) {
    // Steps 1-3.
    return DefaultNumberOption(options[property], minimum, maximum, fallback);
}

// Symbols in the self-hosting compartment can't be cloned, use a separate
// object to hold the actual symbol value.
// TODO: Can we add support to clone symbols?
var intlFallbackSymbolHolder = { value: undefined };

/**
 * The [[FallbackSymbol]] symbol of the %Intl% intrinsic object.
 *
 * This symbol is used to implement the legacy constructor semantics for
 * Intl.DateTimeFormat and Intl.NumberFormat.
 */
function intlFallbackSymbol() {
    var fallbackSymbol = intlFallbackSymbolHolder.value;
    if (!fallbackSymbol) {
        fallbackSymbol = std_Symbol("IntlLegacyConstructedSymbol");
        intlFallbackSymbolHolder.value = fallbackSymbol;
    }
    return fallbackSymbol;
}

/**
 * Initializes the INTL_INTERNALS_OBJECT_SLOT of the given object.
 */
function initializeIntlObject(obj, type, lazyData) {
    assert(IsObject(obj), "Non-object passed to initializeIntlObject");
    assert((type === "Collator" && IsCollator(obj)) ||
           (type === "DateTimeFormat" && IsDateTimeFormat(obj)) ||
           (type === "NumberFormat" && IsNumberFormat(obj)) ||
           (type === "PluralRules" && IsPluralRules(obj)) ||
           (type === "RelativeTimeFormat" && IsRelativeTimeFormat(obj)),
           "type must match the object's class");
    assert(IsObject(lazyData), "non-object lazy data");

    // The meaning of an internals object for an object |obj| is as follows.
    //
    // The .type property indicates the type of Intl object that |obj| is:
    // "Collator", "DateTimeFormat", "NumberFormat", or "PluralRules" (likely
    // with more coming in future Intl specs).
    //
    // The .lazyData property stores information needed to compute -- without
    // observable side effects -- the actual internal Intl properties of
    // |obj|.  If it is non-null, then the actual internal properties haven't
    // been computed, and .lazyData must be processed by
    // |setInternalProperties| before internal Intl property values are
    // available.  If it is null, then the .internalProps property contains an
    // object whose properties are the internal Intl properties of |obj|.

    var internals = std_Object_create(null);
    internals.type = type;
    internals.lazyData = lazyData;
    internals.internalProps = null;

    assert(UnsafeGetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT) === null,
           "Internal slot already initialized?");
    UnsafeSetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT, internals);
}

/**
 * Set the internal properties object for an |internals| object previously
 * associated with lazy data.
 */
function setInternalProperties(internals, internalProps) {
    assert(IsObject(internals.lazyData), "lazy data must exist already");
    assert(IsObject(internalProps), "internalProps argument should be an object");

    // Set in reverse order so that the .lazyData nulling is a barrier.
    internals.internalProps = internalProps;
    internals.lazyData = null;
}

/**
 * Get the existing internal properties out of a non-newborn |internals|, or
 * null if none have been computed.
 */
function maybeInternalProperties(internals) {
    assert(IsObject(internals), "non-object passed to maybeInternalProperties");
    var lazyData = internals.lazyData;
    if (lazyData)
        return null;
    assert(IsObject(internals.internalProps), "missing lazy data and computed internals");
    return internals.internalProps;
}

/**
 * Return |obj|'s internals object (*not* the object holding its internal
 * properties!), with structure specified above.
 *
 * Spec: ECMAScript Internationalization API Specification, 10.3.
 * Spec: ECMAScript Internationalization API Specification, 11.3.
 * Spec: ECMAScript Internationalization API Specification, 12.3.
 */
function getIntlObjectInternals(obj) {
    assert(IsObject(obj), "getIntlObjectInternals called with non-Object");
    assert(IsCollator(obj) || IsDateTimeFormat(obj) ||
           IsNumberFormat(obj) || IsPluralRules(obj) ||
           IsRelativeTimeFormat(obj),
           "getIntlObjectInternals called with non-Intl object");

    var internals = UnsafeGetReservedSlot(obj, INTL_INTERNALS_OBJECT_SLOT);

    assert(IsObject(internals), "internals not an object");
    assert(hasOwn("type", internals), "missing type");
    assert((internals.type === "Collator" && IsCollator(obj)) ||
           (internals.type === "DateTimeFormat" && IsDateTimeFormat(obj)) ||
           (internals.type === "NumberFormat" && IsNumberFormat(obj)) ||
           (internals.type === "PluralRules" && IsPluralRules(obj)) ||
           (internals.type === "RelativeTimeFormat" && IsRelativeTimeFormat(obj)),
           "type must match the object's class");
    assert(hasOwn("lazyData", internals), "missing lazyData");
    assert(hasOwn("internalProps", internals), "missing internalProps");

    return internals;
}

/**
 * Get the internal properties of known-Intl object |obj|.  For use only by
 * C++ code that knows what it's doing!
 */
function getInternals(obj) {
    var internals = getIntlObjectInternals(obj);

    // If internal properties have already been computed, use them.
    var internalProps = maybeInternalProperties(internals);
    if (internalProps)
        return internalProps;

    // Otherwise it's time to fully create them.
    var type = internals.type;
    if (type === "Collator")
        internalProps = resolveCollatorInternals(internals.lazyData);
    else if (type === "DateTimeFormat")
        internalProps = resolveDateTimeFormatInternals(internals.lazyData);
    else if (type === "NumberFormat")
        internalProps = resolveNumberFormatInternals(internals.lazyData);
    else
        internalProps = resolvePluralRulesInternals(internals.lazyData);
    setInternalProperties(internals, internalProps);
    return internalProps;
}
