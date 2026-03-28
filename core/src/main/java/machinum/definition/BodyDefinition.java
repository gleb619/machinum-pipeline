package machinum.definition;

public sealed interface BodyDefinition
    permits RootDefinition.RootBodyDefinition,
        ToolsDefinition.ToolsBodyDefinition,
        PipelineDefinition.PipelineBodyDefinition {}
