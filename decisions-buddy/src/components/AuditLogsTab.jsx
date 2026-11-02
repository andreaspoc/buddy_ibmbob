import React, { useState, useEffect } from 'react';
import { API_BASE } from '../config.js';
import {
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableContainer,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Button,
  Tag,
  Tile,
  CodeSnippet,
  InlineNotification
} from '@carbon/react';
import { Reset } from '@carbon/icons-react';

export default function AuditLogsTab({ backendConnected }) {
  const [logs, setLogs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  const fetchLogs = async () => {
    if (!backendConnected) return;
    setIsLoading(true); setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/decisions/audit-logs?limit=30`);
      if (!res.ok) throw new Error(`Audit request failed (HTTP ${res.status})`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const refreshLogs = () => {
    fetchLogs().catch(err => setError(err?.message || 'Could not load audit logs. Please try again.'));
  };

  useEffect(() => {
    refreshLogs();
  }, [backendConnected]);

  const headers = [
    { key: 'id', header: 'Log #' },
    { key: 'decisionId', header: 'Decision Model' },
    { key: 'userId', header: 'Keycloak User' },
    { key: 'durationMicros', header: 'Latency (μs)' },
    { key: 'nodesExecuted', header: 'Nodes' },
    { key: 'createdAt', header: 'Timestamp (UTC)' }
  ];

  const rows = logs.map((l) => ({
    id: String(l.id),
    decisionId: l.decisionId,
    userId: l.userId || 'anonymous',
    durationMicros: `${l.durationMicros} μs`,
    nodesExecuted: l.nodesExecuted,
    createdAt: new Date(l.createdAt).toLocaleTimeString(),
    raw: l
  }));

  return (
    <div className="decisions-mt-06" >
      <Tile className="decisions-mb-06" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h4 className="decisions-type-heading-02 decisions-m-00" >Decision execution audit trail</h4>
          <p className="decisions-type-body-compact-01 decisions-m-02-00-00-00" style={{ color: 'var(--cds-text-secondary)' }}>
            Historical record of all evaluated decision requests, performance metrics, and outputs saved by the decision service.
          </p>
        </div>
        <div className="decisions-gap-03" style={{ display: 'flex', alignItems: 'center' }}>
          <Tag type="teal" size="md">
            Persistent audit history
          </Tag>
          <Button
            size="sm"
            kind="ghost"
            renderIcon={Reset}
            onClick={refreshLogs}
            disabled={isLoading || !backendConnected}
          >
            {isLoading ? 'Refreshing...' : 'Refresh Logs'}
          </Button>
        </div>
      </Tile>

      {error && <InlineNotification kind="error" title="Audit logs unavailable" subtitle={error} onCloseButtonClick={() => setError(null)} />}
      {logs.length === 0 ? (
        <Tile className="decisions-p-09-05" style={{ textAlign: 'center', color: 'var(--cds-text-secondary)' }}>
          No audit logs recorded yet. Run an evaluation from the <strong>Decision Simulator</strong> to record history.
        </Tile>
      ) : (
        <DataTable rows={rows} headers={headers}>
          {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer title="Recent Evaluation Logs" description="Click any log row to inspect input & output payload snapshots">
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {headers.map((header) => (
                      <TableHeader {...getHeaderProps({ header })}>
                        {header.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const isSelected = selectedLog?.id === Number(row.id);
                    return (
                      <TableRow
                        {...getRowProps({ row })}
                      >
                        {row.cells.map((cell) => (
                          <TableCell key={cell.id}>
                            {cell.info.header === 'decisionId' ? (
                              <button type="button" className="decisions-audit-select" aria-expanded={isSelected} onClick={() => { const fullLog = logs.find(log => String(log.id) === row.id); setSelectedLog(isSelected ? null : fullLog); }}>{cell.value}</button>
                            ) : cell.info.header === 'durationMicros' ? (
                              <strong>{cell.value}</strong>
                            ) : (
                              cell.value
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
      )}

      {/* Selected Log Inspector */}
      {selectedLog && (
        <Tile className="decisions-mt-06" >
          <div className="decisions-mb-05" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h5 className="decisions-type-heading-02 decisions-m-00" >
              Audit Log Details: Record #{selectedLog.id} ({selectedLog.decisionId})
            </h5>
            <span className="decisions-type-body-compact-01" style={{ color: 'var(--cds-text-secondary)' }}>
              Execution time: {selectedLog.durationMicros} μs | {selectedLog.nodesExecuted} nodes
            </span>
          </div>

          <div className="decisions-gap-05" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            <div>
              <div className="decisions-type-label-01 decisions-mb-02" style={{ color: 'var(--cds-text-secondary)' }}>
                INPUT DATA (FROM SQLITE):
              </div>
              <CodeSnippet type="multi" maxCollapsedNumberOfRows={6}>
                {JSON.stringify(selectedLog.inputData, null, 2)}
              </CodeSnippet>
            </div>
            <div>
              <div className="decisions-type-label-01 decisions-mb-02" style={{ color: 'var(--cds-text-secondary)' }}>
                OUTPUT RESULT (FROM SQLITE):
              </div>
              <CodeSnippet type="multi" maxCollapsedNumberOfRows={6}>
                {JSON.stringify(selectedLog.outputResult, null, 2)}
              </CodeSnippet>
            </div>
          </div>
        </Tile>
      )}
    </div>
  );
}
