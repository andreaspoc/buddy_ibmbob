# DecisionsBuddy and IBM data governance

DecisionsBuddy stores decision graphs, immutable versions, approval history and evaluation evidence in the shared PostgreSQL database. IBM Knowledge Catalog (IKC) and watsonx.data intelligence are external governance services. No live server, catalog, term or compliance result is implied by installing the plugin.

## Configure the two services

An application administrator opens **DecisionsBuddy → Catalog governance → Administrator integration settings** and saves each connection independently. The administration API is `/api/decisions/admin/integrations` with provider IDs `ikc` and `wxdi`. Each connection has its own HTTPS server origin, installed product version, API profile, account, catalog and optional organization CA certificate.

The implemented profile is `cpd_common_core_v2`: CPD platform authorization, Common Core catalogs/assets, global search and Knowledge Catalog active business-term versions. IBM documents these APIs for the Software Hub data-governance capabilities used by IKC and watsonx.data intelligence. This does not imply that arbitrary SaaS, lakehouse, Manta or Data Product Hub APIs have the same contracts. Confirm the installed service/version supports this profile before enabling it.

Use a dedicated service account with access only to the intended glossary categories and catalog, including the required metadata create/update permissions. The application authenticates its own users and enforces model ownership; calls to IBM use the configured service identity, not the individual user's IBM identity. Configure that delegated authority deliberately. Only administrator-saved catalogs are writable. A sync request cannot provide another URL, credential or arbitrary catalog.

Choose either username + CPD API key, exchanged server-side through `/icp4d-api/v1/authorize`, or a supplied bearer token. Bearer tokens expire and must be rotated; username/API-key mode obtains current tokens automatically. Credentials are write-only in the UI and API, encrypted in PostgreSQL with a purpose-derived Fernet key, and never supplied to the browser or agent context. A blank credential retains the previous value only while the server/account/authentication method is unchanged. Preserve the service-only `BUDDY_CP4D_ENCRYPTION_KEY`, or the existing `BUDDY_MEMORY_SIGNING_KEY` fallback, across restarts and replicas. Key loss requires re-entering the credentials.

The **Test connection** operation uses the saved configuration, authenticates, lists accessible catalogs and verifies the saved target catalog. A successful test confirms connectivity and those permissions; it does not prove legal compliance, data quality, or access to every API capability. No real connection test has been performed in this workspace because server URLs, versions and credentials have not been supplied.

Network requirements: allow outbound HTTPS from the DecisionsBuddy execution service to each configured CPD machine. Private enterprise IPs and nonstandard HTTPS ports are supported only for that saved origin. TLS certificate validation remains enabled; provide the organization's CA certificate when needed. DNS is resolved and pinned at connection time. Loopback, link-local and metadata destinations are blocked. Proxy environment variables, redirects, browser-provided destinations and insecure TLS bypasses are not supported. Requests have bounded sizes/timeouts and discovery returns at most the first 100 catalog/term search records.

## How governance is used

1. The owner saves a draft decision version in PostgreSQL. Local simulation and static analysis help test the rule graph; their results do not authorize production execution.
2. Decision-table input/output fields appear as **unmapped**. An owner or administrator selects real business terms from either configured provider. Search results are discovery only; assignment fetches an active term version and records provider, origin, term ID/version and response digest. The application does not guess a steward, classification, policy result or term mapping.
3. The owner explicitly synchronizes the saved version. DecisionsBuddy revalidates mapped active terms and publishes a metadata asset to each enabled provider's saved catalog. The transmitted metadata contains decision identity/version, graph digest, field names and mapping digest. It excludes rule expressions, evaluation inputs/outputs, customer records, audit bodies and credentials.
4. A remote asset ID and readback of the exact version/digest marker are required before a source counts as acknowledged. The PostgreSQL governance snapshot records both providers' actual asset/catalog identities, saved connection revision, decision version, graph/mapping digests and check time. When both connectors address the same Common Core origin/catalog, they reuse the asset rather than create duplicates; these are two logical connector records, not independent certifications.
5. The existing application review/publication workflow remains separate. The local release gate requires fresh snapshot evidence from every enabled provider, active mappings for all current decision-table fields and an exact match to the decision version and graph. Evidence expires after `BUDDY_DECISIONS_GOVERNANCE_TTL_SECONDS` (default 3600; effective bounds 60–86400 seconds). The implemented production release gate requires this evidence; simulation does not.
6. Editing rule graphs, changing mapped terms or changing connection settings invalidates the old evidence. Mapping/settings changes and synchronization/reconciliation demote previously approved/published models to review and clear the prior approver. Fresh metadata synchronization cannot silently reuse an earlier approval.

The snapshot is a local metadata release gate. It does not evaluate CPD data-protection rules for arbitrary runtime records or claim that upstream quality rules passed. A regulated use case may additionally require approved reference data, runtime policy evaluation, data-quality evidence and independent human/legal review. Those integrations must use their own documented APIs and explicit acceptance criteria.

## Outages, uncertainty and recovery

Disconnected, disabled, stale, failed and unresolved connections remain visibly distinct. Metadata synchronization is never simulated when a server is unavailable. PostgreSQL remains authoritative for saved drafts and history; a remote outage does not erase local work.

An ambiguous remote create can have taken effect even when its response was lost. The plugin records `reconciliation_required` and blocks blind retries. An administrator must locate the asset in the saved remote catalog and explicitly adopt its ID using the reconciliation operation, which validates the decision marker. Adoption makes the local record stale, not approved: synchronize the current version and obtain fresh review before production use. A crash leaving `pending` requires the same investigation. Successful provider identities are checkpointed so a failure at the second service does not discard acknowledged work from the first.

The lineage view is a **local design lineage document** showing mapped input/output relationships. No remote Manta/OpenLineage ingestion is claimed. Likewise, catalog registration does not establish GDPR/BCBS or other legal certification. Imported legacy metadata is marked unverified and cannot pass the release gate until revalidated against actual services.

## Verification

`PYTHONPATH=/tmp/mcp-python-deps python3 -m unittest tests.test_decisions_cp4d -v` exercises synthetic HTTP contracts, response bounds, redirects, private-origin configuration, credential encryption, active-term evidence, both-provider snapshots, staleness and preservation of caller-owned transactions. The temporary dependency path is specific to this workspace; in the built application use its installed dependencies. Tests do not contact CPD or publish remote assets.

Authoritative IBM references:

- [Software Hub available APIs](https://www.ibm.com/docs/en/software-hub/5.4.x?topic=started-available-apis) describes the Common Core and Knowledge Catalog API families available to watsonx.data intelligence.
- [Knowledge Catalog software API](https://cloud.ibm.com/apidocs/knowledge-catalog-cpd) documents CPD platform authorization and active business-term version retrieval.
- [Data & AI Common Core software API](https://cloud.ibm.com/docs/apis/data-ai-common-core-cpd/data-ai-common-core-cpd-5.2.2) documents catalogs, assets, global search and metadata updates.
- [Generating CPD bearer tokens](https://www.ibm.com/docs/en/cloud-paks/cp-data/5.4.x?topic=keys-generating-bearer-token) documents username/API-key authorization and token use.
