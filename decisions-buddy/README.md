# DecisionsBuddy

Carbon-based decision tables, graph simulation, version history and IBM governance integration.

The authenticated backend is `app/decisions_buddy`, using the shared PostgreSQL database. This frontend does not execute imported scripts, impersonate users through URL parameters, or silently replace a failed backend with a browser evaluator.

Use Node 24: `npm ci` then `npm run build`. The production URL is `/decisions/`; development requests under `/api/decisions` proxy to the existing application at port 8080. Sign in through that application.

See [setup, persistence and Docker deployment](../docs/decisionsbuddy.md), [GoRules Zen engine & language bindings](../docs/decisions-engine-and-bindings.md), [IKC and watsonx.data intelligence integration](../docs/decisions-cp4d.md), and [Carbon typography and spacing](../docs/decisions-carbon.md).

The `backend` folder contains compatibility imports, not a second persistence implementation. Its historical SQLite database is retained only for explicit migration.
