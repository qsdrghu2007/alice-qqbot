// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
const MIB_BYTES = 1024 * 1024;
const CAPABILITY_KEYS = [
  "space",
  "stickers",
  "proactivePrivateMessages",
  "review",
  "userUnderstanding",
  "externalActions",
];

export function mibToBytes(mib) {
  return Math.round(Number(mib) * MIB_BYTES);
}

export function bytesToMib(bytes) {
  return Number((Number(bytes) / MIB_BYTES).toFixed(3));
}

export function resolveRuntimeCapabilities(payload) {
  const source = [
    payload?.runtimeCapabilities,
    payload?.data?.runtimeCapabilities,
    payload?.config?.runtimeCapabilities,
    payload?.data?.config?.runtimeCapabilities,
  ].find((value) => value && typeof value === "object" && !Array.isArray(value));
  const basicMode = source?.basicMode === true;
  const capabilities = { basicMode };
  for (const key of CAPABILITY_KEYS) {
    capabilities[key] = basicMode
      ? false
      : typeof source?.[key] === "boolean"
        ? source[key]
        : true;
  }
  return capabilities;
}

export function resolveRuntimeModeInfo(payload) {
  const explicit = [
    payload?.runtimeModeInfo,
    payload?.data?.runtimeModeInfo,
    payload?.runtimeMode,
    payload?.data?.runtimeMode,
  ].find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      ["basic", "full"].includes(value.mode),
  );
  if (explicit) {
    return {
      mode: explicit.mode,
      source: ["config", "environment", "default", "runtime"].includes(explicit.source)
        ? explicit.source
        : "runtime",
    };
  }
  const capabilities = [
    payload?.runtimeCapabilities,
    payload?.data?.runtimeCapabilities,
    payload?.config?.runtimeCapabilities,
    payload?.data?.config?.runtimeCapabilities,
  ].find(
    (value) =>
      value &&
      typeof value === "object" &&
      !Array.isArray(value),
  );
  if (!capabilities) return { mode: "basic", source: "default" };
  return {
    mode: capabilities.basicMode === true ? "basic" : "full",
    source: "runtime",
  };
}
