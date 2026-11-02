# Small-Scale Noncommercial Community Exception

Copyright (c) 2026 Alice QQ Bot contributors

This is a custom additional permission under section 7 of the GNU Affero
General Public License, version 3. It is not the MIT License and has not
been approved as an open-source license by the Open Source Initiative.
It is offered with AGPL-3.0-or-later as described in the project
`LICENSE`; it does not replace or alter the AGPLv3 text.

## 1. Threshold

The only scale number is:

| Name | Value |
| --- | --- |
| `MAX_AUTHORIZED_USERS` | **20** |

"Authorized users" means the different natural persons currently allowed
to access a hosted or interactive deployment. Include administrators.
Do not use monthly active users. Count every member who can interact
through a QQ group or other shared conversation. A public bot or any
group that can add arbitrary members is public under section 2 even if
fewer than 20 people have used it so far.

All deployments, instances, channels and accounts operated by the same
operator, controlled by the same organization or people, or used for the
same beneficiary or coordinated purpose are aggregated. Creating smaller
instances, groups, account shells, or intermediary operators does not
reset the count. The total must remain at or below
`MAX_AUTHORIZED_USERS` at all times.

A person who only downloads the source, reads it, or runs it locally
without making a hosted service available to other people does not count
as another authorized user. Ordinary local personal use is one user.

## 2. Closed Access

The deployment must not be open to an unspecified public. In particular,
it must not provide public registration, self-service admission, an
unrestricted public bot, or service to an open public group.

An allowlist, private invitation, or access-control setting is evidence
of the operator's intent, but does not by itself make a deployment
nonpublic. The people who can actually access the service determine
whether it is closed. Publishing source code in a public repository is
compatible with this Exception and does not make the hosted service
public.

## 3. Noncommercial Use

The use must not be for money-making or for direct or indirect commercial
advantage. The following are commercial uses:

- charging fees, subscriptions or paid access;
- advertising, promotion, sponsorship sold as promotion, lead generation,
  sale of products or services, or monetization of user data;
- including the Software in a commercial product, paid service or
  commercial hosted service, including a free service used to attract
  customers or support another revenue-generating product;
- using it in a business or organization's production environment or
  ordinary internal business operations, even when no fee is charged;
- research, experimentation or proof-of-concept work performed for an
  employer or organization's business purpose;
- work paid for or commissioned to produce proprietary or commercial
  results for a business sponsor.

Ordinary personal study, experimentation, hobbies and student projects
qualify when they meet every other condition. A closed course or research
project at a school or other nonprofit institution may qualify as
noncommercial when it has no commercial purpose and no more than
`MAX_AUTHORIZED_USERS` participants. Charging ordinary tuition, or
receiving a grant for noncommercial research, does not by itself make a
course or research project commercial.

A nonprofit organization's ordinary production or business operations
do not qualify merely because the organization is nonprofit. A public
community instance does not qualify merely because it is free or
nonprofit; it must comply with the AGPLv3.

An employee's private, unpaid hobby may qualify when it is unrelated to
the employer's business and does not provide a direct or indirect
commercial benefit to the employer.

Voluntary donations qualify only when the donor receives no advertising,
promotion, priority access or other consideration, the operator does not
distribute profits, and donations are used to cover verified direct
hosting or operating costs and do not exceed those costs. Normal
acknowledgement of a supporter is allowed when it is not promotion or
advertising.

## 4. Permission

Subject to every condition above, the copyright holders grant a direct
additional permission under section 7 of the AGPLv3 to use, reproduce,
modify, merge, deploy and distribute the Software for that qualifying
use. For that use only, the permission waives the source-code disclosure
and copyleft conditions of AGPLv3 sections 4 through 6 and section 13.

This is permission to use the project under the project's layered
license. It is not permission to relicense the project as MIT or to
sublicense it under another license. Modification may be kept private
within a qualifying use.

Every copy or version distributed under this Exception must retain this
file, the project `LICENSE`, the complete AGPLv3 text, all third-party
notices and the applicable copyright and warranty notices. It must state
that the project uses AGPL-3.0-or-later plus this Exception. A person who
receives the project does not inherit the sender's eligibility. Each
recipient must independently qualify. A recipient who does not qualify
may use the project only under the AGPLv3.

A recipient may remove this additional permission and use a version
under pure AGPL-3.0-or-later as allowed by section 7. Doing so does not
make the project MIT-licensed.

## 5. Changes In Use

The Exception applies only while the scale, closed-access and
noncommercial conditions are all met. If a use becomes commercial,
exceeds the threshold or becomes open to an unspecified public, the
Exception stops applying to that use when it changes. From that point
the user must satisfy the AGPLv3 or stop the use. This is not a
retroactive withdrawal: already lawful acts remain lawful. The AGPLv3's
own termination and reinstatement rules apply.

The copyright holders may change `MAX_AUTHORIZED_USERS` or other
conditions for future grants. A change does not remove a permission
already granted for an earlier qualifying use.

This Exception does not add a commercial prohibition or a user limit to
pure AGPLv3 use. Commercial use is allowed under the AGPLv3 when its
copying, distribution and network-source obligations are met. A private
internal use that does not distribute the Software and that has no
section 13 network interaction does not create a duty to publish a
fork merely because the use is commercial.

The Software is provided without warranty and the copyright holders are
not liable for damages. No trademark rights are granted.
