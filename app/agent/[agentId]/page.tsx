import { AgentDashboard } from './AgentDashboard';
import type { Id } from '@convex/_generated/dataModel';

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <AgentDashboard agentId={agentId as Id<'agents'>} />;
}
