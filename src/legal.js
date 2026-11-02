// SPDX-License-Identifier: LicenseRef-Alice-Source-Available
// See LICENSE and LICENSES/ALICE-SOURCE-AVAILABLE.md.
const DEFAULT_SOURCE_URL = "https://github.com/qsdrghu2007/alice-qqbot";
const SOURCE_URL_ENV = "ALICE_SOURCE_URL";
const PROJECT_VERSION = "0.4.0";
const COPYRIGHT_NOTICE = "Copyright (c) 2026 Alice QQ Bot contributors";

const LICENSE_NOTICE = [
  COPYRIGHT_NOTICE,
  "Source-available under the Alice Noncommercial and Commercial Revenue-Sharing License v1.0.",
  "Eligible closed, noncommercial deployments with at most 3 authorized users are royalty-free.",
  "All Commercial Use requires prior written consent and a separate revenue-sharing agreement.",
  "No AGPL-3.0 fallback is offered for versions v0.4.0 and later.",
  "This software is provided without warranty. See LICENSE for the complete terms.",
].join("\n");

export const LEGAL_FILES = Object.freeze([
  "LICENSE",
  "LICENSES/ALICE-SOURCE-AVAILABLE.md",
  "LICENSES/COMMUNITY-PERMISSION.md",
  "THIRD_PARTY_LICENSES.md",
]);

export class LegalConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegalConfigurationError";
    this.code = "LEGAL_CONFIGURATION_ERROR";
  }
}

function isRestrictedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "0.0.0.0") return true;
  if (
    host.includes(":") &&
    (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))
  ) {
    return true;
  }

  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((value) => value > 255)) return true;
  const [a, b] = octets;
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function validateSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? "").trim());
  } catch {
    throw new LegalConfigurationError(
      `${SOURCE_URL_ENV} must be an absolute HTTPS URL`,
    );
  }
  if (parsed.protocol !== "https:") {
    throw new LegalConfigurationError(
      `${SOURCE_URL_ENV} must use HTTPS`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new LegalConfigurationError(
      `${SOURCE_URL_ENV} must not contain user credentials`,
    );
  }
  if (!parsed.hostname || isRestrictedHost(parsed.hostname)) {
    throw new LegalConfigurationError(
      `${SOURCE_URL_ENV} must use a public hostname`,
    );
  }
  return parsed.href;
}

export function resolveSourceUrl(explicitSourceUrl, env = process.env) {
  const configured =
    typeof explicitSourceUrl === "string" && explicitSourceUrl.trim()
      ? explicitSourceUrl
      : env?.[SOURCE_URL_ENV] ?? DEFAULT_SOURCE_URL;
  return validateSourceUrl(configured);
}

export function sourceReply(sourceUrl) {
  return [
    `Source code for Alice ${PROJECT_VERSION}: ${sourceUrl}`,
    "This link identifies the source for the deployed version.",
    `A modified deployment should set ${SOURCE_URL_ENV} to its actual published source.`,
  ].join("\n");
}

export function licenseReply(sourceUrl) {
  return [
    LICENSE_NOTICE,
    "License texts are included in the corresponding source (LICENSE and LICENSES/...).",
    `Source code: ${sourceUrl}`,
  ].join("\n");
}

export function legalReplyFor(command, sourceUrl) {
  return command === "/source" ? sourceReply(sourceUrl) : licenseReply(sourceUrl);
}

export function isLegalCommandText(value) {
  return ["/source", "/license"].includes(
    String(value ?? "").trim().toLocaleLowerCase("en-US"),
  );
}

export function legalConfigurationMessage() {
  return [
    `Source code link unavailable: ${SOURCE_URL_ENV} is invalid.`,
    "The operator must configure an absolute HTTPS URL with no credentials",
    "and a public hostname before using this deployment's source and license links.",
  ].join(" ");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export {
  COPYRIGHT_NOTICE,
  DEFAULT_SOURCE_URL,
  LICENSE_NOTICE,
  PROJECT_VERSION,
  SOURCE_URL_ENV,
};
