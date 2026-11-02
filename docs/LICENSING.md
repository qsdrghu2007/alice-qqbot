# Licensing

Copyright (c) 2026 Alice QQ Bot contributors

This project is source-available. It is not offered as an OSI-approved
open-source project.

The controlling files for current versions are:

- `LICENSE`: short project notice and entry point;
- `LICENSES/ALICE-SOURCE-AVAILABLE.md`: complete custom license;
- `LICENSES/COMMUNITY-PERMISSION.md`: current noncommercial permission,
  including the twenty-user scale limit; and
- `THIRD_PARTY_LICENSES.md`: third-party notices.

## Version History

| Version | Licensing position |
| --- | --- |
| v0.2.1 and earlier | MIT. Those grants remain valid and cannot be revoked. |
| v0.3.0 | AGPL-3.0-or-later plus the original 20-user Community Exception. Its original files are preserved under `LICENSES/history/v0.3.0/`. |
| v0.4.0 and later | Alice Noncommercial and Commercial Revenue-Sharing License v1.0 plus the current 20-user Community Permission. |

The historical materials document only the versions identified there.
They do not create an AGPL-3.0 or MIT option for v0.4.0 or later.

## Current Noncommercial Use

A closed deployment with no more than `MAX_AUTHORIZED_USERS = 20`
different natural persons may use the Software royalty-free when the use
is noncommercial. Administrators count. Count every member who can
interact through a QQ group or other shared conversation.

Use current authorized access rather than monthly active users. All
instances, groups, channels and accounts under common control, operated
for the same beneficiary, or serving a coordinated purpose are added
together. Splitting a deployment into smaller instances does not reset
the count.

Ordinary personal study, experimentation, hobbies and a student's own
project may qualify. A closed school course or closed noncommercial
research project may qualify. Tuition or a noncommercial research grant
does not by itself make the use commercial.

An open public bot, public registration, an unrestricted public group
or a public community instance requires prior written authorization.
Organization production use also requires prior written authorization.
A nonprofit organization does not qualify automatically for production
or ordinary business operations.

Noncommercial use above twenty Authorized Users likewise requires prior
written authorization from the copyright holder. The current license has
no automatic AGPL-3.0 fallback.

Voluntary donations remain noncommercial only when the donor receives no
advertising, promotion, priority access, data benefit or other
consideration, and donations do not exceed verified direct hosting or
operating costs.

## Commercial Use

All Commercial Use requires the copyright holder's prior written consent
and a separate written commercial agreement that provides for revenue
sharing. Commercial Use includes paid access, subscriptions, advertising,
promotion, sponsorship, lead generation, affiliate traffic, data
monetization, paid SaaS, a free service supporting another commercial
product, and use by or for a company in internal operations, production,
product development, evaluation or business-directed research.

The commercial agreement must explicitly state the revenue-sharing
percentage or formula, the revenue or fee base, the calculation period,
the settlement terms and any other commercial terms the parties choose.
The project does not set a default percentage.

Downloading, opening an issue, proposing terms, submitting a form or
sending a payment without a written agreement accepted by the copyright
holder does not grant commercial rights. Commercial inquiries may be
opened through the GitHub maintainer profile or a GitHub issue; financial
details need not be posted publicly.

## Redistribution And Forks

The Community Permission is not transferable eligibility. Every
recipient must independently qualify.

Every redistributed copy and modified version of covered project code
must retain `LICENSE`, `LICENSES/ALICE-SOURCE-AVAILABLE.md`,
`LICENSES/COMMUNITY-PERMISSION.md`, applicable third-party notices and
all copyright and warranty notices. It must remain identified as
source-available under the custom license.

You may not call covered project code MIT-licensed or AGPL-licensed, or
relicense it under MIT, AGPL-3.0 or another open-source label. A fork,
wrapper, intermediary or renamed service does not create commercial
rights that the copyright holder has not granted.

These restrictions do not revoke older version-specific grants or limit
rights supplied independently by a third-party license.

## Source And License Entry Points

The web UI exposes `/source` and `/license`. QQ/OneBot users can use the
existing `/source` and `/license` commands where policy permits. The
entry points help users obtain source and current terms, but this version
does not impose an AGPL section 13 source-disclosure condition. A
commercial agreement may separately address source availability,
support, attribution or reporting.

`ALICE_SOURCE_URL` determines the `/source` redirect. It must be an
absolute HTTPS URL without credentials or a private host. The default is
the upstream GitHub repository. A modified deployment should point it at
the actual published source for the deployed version.

## Contributions And Third Parties

Contributions are accepted under the current custom license, Community
Permission and the limited commercial-authorization grant described in
`CONTRIBUTING.md`. Contributors retain copyright. The project does not
use a broad copyright-assignment CLA.

Third-party code and assets remain under their own licenses. See
`THIRD_PARTY_LICENSES.md`.
