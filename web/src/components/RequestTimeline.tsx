import type { RequestDelivery } from '../lib/requestDelivery';
import { t } from '../lib/i18n';
const labels = { sending: 'Sending', accepted: 'Accepted', queued: 'Queued', running: 'Running', streaming: 'Streaming', saving: 'Completed', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' };
export function DeliveryStatus({ request }: { request: RequestDelivery }) {
  return request.deliveryState ? <small className="request-delivery-status" role="status">{t(labels[request.deliveryState])}</small> : null;
}
export function RequestTimeline({ request }: { request: RequestDelivery }) {
  if (!request.deliveryTimeline?.length) return null;
  return <details className="request-delivery-timeline" style={{ fontSize: '12px', marginTop: '8px', opacity: 0.85 }}>
    <summary style={{ cursor: 'pointer' }}>{t('Request timeline')}{request.deliveryState ? ` · ${t(labels[request.deliveryState])}` : ''}</summary>
    <ol style={{ paddingLeft: '20px', margin: '8px 0' }}>{request.deliveryTimeline.map(step => <li key={`${step.state}:${step.timestamp}:${step.source}`}>
      <span>{t(labels[step.state])}</span>{' · '}<time dateTime={step.timestamp} title={new Date(step.timestamp).toLocaleString()}>{new Date(step.timestamp).toLocaleTimeString()}</time>
      {step.source === 'local' ? <span>{' · '}{t('On this device')}</span> : null}
    </li>)}</ol>
  </details>;
}
