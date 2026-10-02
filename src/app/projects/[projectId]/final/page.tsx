import { FinalPromptWorkspace } from "@/components/project/FinalPromptWorkspace";

export default async function FinalPromptPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <FinalPromptWorkspace projectId={projectId} />;
}
