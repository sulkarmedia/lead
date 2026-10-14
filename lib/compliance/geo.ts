// Lead time zone resolution: ZIP, else area code, else the org's zone.
// When a state spans zones and we can't narrow it down, we return every candidate and the send-window
// check uses the strictest (intersection) — see sendWindow.ts.

/** ZIP3 prefix ranges → state. */
const ZIP3: Array<[number, number, string]> = [
  [5, 5, "NY"], [6, 7, "PR"], [8, 8, "VI"], [9, 9, "PR"], [10, 27, "MA"], [28, 29, "RI"], [30, 38, "NH"],
  [39, 49, "ME"], [50, 59, "VT"], [60, 69, "CT"], [70, 89, "NJ"], [100, 149, "NY"], [150, 196, "PA"],
  [197, 199, "DE"], [200, 200, "DC"], [201, 201, "VA"], [202, 205, "DC"], [206, 219, "MD"], [220, 246, "VA"],
  [247, 268, "WV"], [270, 289, "NC"], [290, 299, "SC"], [300, 319, "GA"], [320, 339, "FL"], [341, 349, "FL"],
  [350, 369, "AL"], [370, 385, "TN"], [386, 397, "MS"], [398, 399, "GA"], [400, 427, "KY"], [430, 459, "OH"],
  [460, 479, "IN"], [480, 499, "MI"], [500, 528, "IA"], [530, 549, "WI"], [550, 567, "MN"], [570, 577, "SD"],
  [580, 588, "ND"], [590, 599, "MT"], [600, 629, "IL"], [630, 658, "MO"], [660, 679, "KS"], [680, 693, "NE"],
  [700, 714, "LA"], [716, 729, "AR"], [730, 749, "OK"], [750, 799, "TX"], [800, 816, "CO"], [820, 831, "WY"],
  [832, 838, "ID"], [840, 847, "UT"], [850, 865, "AZ"], [870, 884, "NM"], [885, 885, "TX"], [889, 898, "NV"],
  [900, 961, "CA"], [967, 968, "HI"], [969, 969, "GU"], [970, 979, "OR"], [980, 994, "WA"], [995, 999, "AK"],
];

/** Every zone a state's population may be in. First entry is the dominant zone. */
export const STATE_ZONES: Record<string, string[]> = {
  AL: ["America/Chicago"], AK: ["America/Anchorage", "America/Adak"], AZ: ["America/Phoenix"], AR: ["America/Chicago"],
  CA: ["America/Los_Angeles"], CO: ["America/Denver"], CT: ["America/New_York"], DE: ["America/New_York"],
  DC: ["America/New_York"], FL: ["America/New_York", "America/Chicago"], GA: ["America/New_York"],
  HI: ["Pacific/Honolulu"], ID: ["America/Boise", "America/Los_Angeles"], IL: ["America/Chicago"],
  IN: ["America/Indiana/Indianapolis", "America/Chicago"], IA: ["America/Chicago"], KS: ["America/Chicago", "America/Denver"],
  KY: ["America/New_York", "America/Chicago"], LA: ["America/Chicago"], ME: ["America/New_York"], MD: ["America/New_York"],
  MA: ["America/New_York"], MI: ["America/Detroit", "America/Menominee"], MN: ["America/Chicago"], MS: ["America/Chicago"],
  MO: ["America/Chicago"], MT: ["America/Denver"], NE: ["America/Chicago", "America/Denver"], NV: ["America/Los_Angeles"],
  NH: ["America/New_York"], NJ: ["America/New_York"], NM: ["America/Denver"], NY: ["America/New_York"],
  NC: ["America/New_York"], ND: ["America/Chicago", "America/Denver"], OH: ["America/New_York"], OK: ["America/Chicago"],
  OR: ["America/Los_Angeles", "America/Boise"], PA: ["America/New_York"], RI: ["America/New_York"], SC: ["America/New_York"],
  SD: ["America/Chicago", "America/Denver"], TN: ["America/Chicago", "America/New_York"], TX: ["America/Chicago", "America/Denver"],
  UT: ["America/Denver"], VT: ["America/New_York"], VA: ["America/New_York"], WA: ["America/Los_Angeles"],
  WV: ["America/New_York"], WI: ["America/Chicago"], WY: ["America/Denver"], PR: ["America/Puerto_Rico"],
  VI: ["America/St_Thomas"], GU: ["Pacific/Guam"],
};

/** ZIP3 prefixes that pin a multi-zone state to one zone. */
const ZIP3_ZONE: Array<[number, number, string]> = [
  [320, 323, "America/New_York"], [324, 325, "America/Chicago"], [326, 349, "America/New_York"], // FL panhandle is Central
  [750, 797, "America/Chicago"], [798, 799, "America/Denver"], [885, 885, "America/Denver"], // El Paso is Mountain
  [370, 372, "America/Chicago"], [373, 374, "America/New_York"], [376, 379, "America/New_York"], [380, 385, "America/Chicago"],
  [460, 462, "America/Indiana/Indianapolis"], [463, 464, "America/Chicago"], [465, 475, "America/Indiana/Indianapolis"],
  [476, 477, "America/Chicago"], [478, 479, "America/Indiana/Indianapolis"], // Gary and Evansville are Central
  [400, 418, "America/New_York"], [420, 420, "America/Chicago"], [421, 422, "America/Chicago"], [423, 424, "America/Chicago"],
  [480, 497, "America/Detroit"],
  [970, 978, "America/Los_Angeles"],
];

/** Area code → state (NANP, US only). */
const AREA_CODES: Record<string, string> = {};
const AC_BY_STATE: Record<string, string> = {
  AL: "205 251 256 334 659 938", AK: "907", AZ: "480 520 602 623 928", AR: "479 501 870 327",
  CA: "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951",
  CO: "303 719 720 970 983", CT: "203 475 860 959", DE: "302", DC: "202 771",
  FL: "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954",
  GA: "229 404 470 478 678 706 762 770 912 943", HI: "808", ID: "208 986",
  IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872", IN: "219 260 317 463 574 765 812 930",
  IA: "319 515 563 641 712", KS: "316 620 785 913", KY: "270 364 502 606 859", LA: "225 318 337 504 985",
  ME: "207", MD: "227 240 301 410 443 667", MA: "339 351 413 508 617 774 781 857 978",
  MI: "231 248 269 313 517 586 616 679 734 810 906 947 989", MN: "218 320 507 612 651 763 952",
  MS: "228 601 662 769", MO: "314 417 557 573 636 660 816 235", MT: "406", NE: "308 402 531",
  NV: "702 725 775", NH: "603", NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575",
  NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934",
  NC: "252 336 472 704 743 828 910 919 980 984", ND: "701", OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
  OK: "405 539 572 580 918", OR: "458 503 541 971", PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878",
  RI: "401", SC: "803 821 839 843 854 864", SD: "605", TN: "423 615 629 731 865 901 931",
  TX: "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979",
  UT: "385 435 801", VT: "802", VA: "276 434 540 571 686 703 757 804 826 948", WA: "206 253 360 425 509 564",
  WV: "304 681", WI: "262 274 353 414 534 608 715 920", WY: "307", PR: "787 939", VI: "340", GU: "671",
};
for (const [st, codes] of Object.entries(AC_BY_STATE)) for (const c of codes.split(" ")) AREA_CODES[c] = st;

/** Area codes that pin a multi-zone state to one zone. */
const AREA_ZONE: Record<string, string> = {
  "850": "America/Chicago", "448": "America/Chicago", // FL panhandle (850 is split; Pensacola/Panama City dominate)
  "915": "America/Denver", // El Paso
  "901": "America/Chicago", "615": "America/Chicago", "629": "America/Chicago", "731": "America/Chicago", "931": "America/Chicago",
  "865": "America/New_York", "423": "America/New_York",
  "270": "America/Chicago", "364": "America/Chicago", "502": "America/New_York", "859": "America/New_York", "606": "America/New_York",
  "317": "America/Indiana/Indianapolis", "463": "America/Indiana/Indianapolis", "765": "America/Indiana/Indianapolis", "260": "America/Indiana/Indianapolis",
  "541": "America/Los_Angeles", "503": "America/Los_Angeles", "971": "America/Los_Angeles", "458": "America/Los_Angeles",
  "906": "America/Detroit",
};

export function stateFromZip(zip: string | null | undefined): string | null {
  const z = (zip ?? "").trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const p = Number(z.slice(0, 3));
  for (const [a, b, st] of ZIP3) if (p >= a && p <= b) return st;
  return null;
}

export function stateFromPhone(e164: string | null | undefined): string | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164 ?? "");
  return m ? AREA_CODES[m[1]] ?? null : null;
}

export interface ZoneGuess {
  timezone: string;          // best single guess (for display and booking)
  candidates: string[];      // every plausible zone; compliance uses the strictest
  usState: string | null;
  source: "zip" | "area_code" | "org";
}

export function resolveTimezone(input: { zip?: string | null; phone?: string | null; orgTimezone: string }): ZoneGuess {
  const zip = (input.zip ?? "").trim().slice(0, 5);
  const zipState = stateFromZip(zip);
  if (zipState && STATE_ZONES[zipState]) {
    const p = Number(zip.slice(0, 3));
    const pinned = ZIP3_ZONE.find(([a, b]) => p >= a && p <= b)?.[2];
    const zones = STATE_ZONES[zipState];
    if (pinned || zones.length === 1) {
      const tz = pinned ?? zones[0];
      return { timezone: tz, candidates: [tz], usState: zipState, source: "zip" };
    }
    return { timezone: zones[0], candidates: zones, usState: zipState, source: "zip" };
  }
  const phoneState = stateFromPhone(input.phone);
  if (phoneState && STATE_ZONES[phoneState]) {
    const ac = input.phone!.slice(2, 5);
    const zones = STATE_ZONES[phoneState];
    const pinned = AREA_ZONE[ac];
    // Area codes are portable: a cell number may live anywhere. Keep the org's zone as a candidate too.
    const base = pinned ? [pinned] : zones;
    const candidates = Array.from(new Set([...base, input.orgTimezone]));
    return { timezone: base[0], candidates, usState: phoneState, source: "area_code" };
  }
  return { timezone: input.orgTimezone, candidates: [input.orgTimezone], usState: null, source: "org" };
}
