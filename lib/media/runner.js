import { collectOutputs, historyIssues, submitWorkflow, waitForPrompt } from '../comfy/workflow-runner.js';
/** Submit a media workflow, wait for completion, and collect the produced files. */
export async function runMediaWorkflow(options) {
    const startedAt = Date.now();
    const client = options.client;
    const timeoutMs = options.timeoutMs ?? options.config.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? options.config.pollIntervalMs;
    await client.systemStats(options.signal);
    const promptId = await submitWorkflow(client, options.workflow, options.signal);
    const entry = await waitForPrompt(client, promptId, {
        timeoutMs,
        pollIntervalMs,
        ...(options.signal ? { signal: options.signal } : {})
    });
    const status = String(entry.status?.status_str ?? 'unknown');
    const completed = Boolean(entry.status?.completed);
    const issues = historyIssues(entry);
    const collected = await collectOutputs(client, entry, {
        cwd: options.cwd,
        config: options.config,
        promptId,
        ...(options.outputPath ? { outputPath: options.outputPath } : {}),
        writeMetadata: options.writeMetadata !== false,
        maxOutputs: 20,
        workflow: options.workflow,
        history: entry,
        kind: options.kind,
        ...(options.extraMetadata ? { extraMetadata: options.extraMetadata } : {}),
        ...(options.signal ? { signal: options.signal } : {})
    });
    return {
        promptId,
        status,
        completed,
        issues,
        files: collected.files,
        outputs: collected.outputs,
        textOutputs: collected.text_outputs,
        warnings: collected.warnings,
        ...(collected.metadata_path ? { metadataPath: collected.metadata_path } : {}),
        durationMs: Date.now() - startedAt
    };
}
