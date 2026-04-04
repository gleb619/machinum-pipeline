package machinum.compiler;

import java.util.Collections;
import java.util.List;
import machinum.definition.PipelineConfigDefinition;
import machinum.definition.PipelineDefinition;
import machinum.definition.PipelineDefinition.FallbackDefinition;
import machinum.definition.PipelineDefinition.ItemsDefinition;
import machinum.definition.PipelineDefinition.PipelineBodyDefinition;
import machinum.definition.PipelineDefinition.SourceDefinition;
import machinum.definition.PipelineStateDefinition;
import machinum.manifest.PipelineManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.factory.Mappers;

@Mapper(
    uses = {
      CommonCompiler.class,
      PipelineConfigCompiler.class,
      SourceCompiler.class,
      ItemsCompiler.class,
      StateCompiler.class,
      FallbackCompiler.class
    })
// TODO: Add support of `snapshot`
public interface PipelineManifestCompiler
    extends YamlCompiler<PipelineManifest, PipelineDefinition> {

  PipelineManifestCompiler INSTANCE = Mappers.getMapper(PipelineManifestCompiler.class);

  @Mapping(target = "labels", qualifiedByName = "simpleMap")
  @Mapping(target = "metadata", qualifiedByName = "simpleMap")
  @Mapping(target = "body", expression = "java(createBody(source, ctx))")
  PipelineDefinition compile(PipelineManifest source, @Context CompilationContext ctx);

  default PipelineBodyDefinition createBody(
      PipelineManifest source, @Context CompilationContext ctx) {
    validate(source);

    var body = source.body();
    CompiledMap<String> variables = CommonCompiler.INSTANCE.compileMap(body.variables(), ctx);
    PipelineConfigDefinition pipelineConfig =
        PipelineConfigCompiler.INSTANCE.compile(body.config(), ctx);
    SourceDefinition compiledSource = SourceCompiler.INSTANCE.compile(body.source(), ctx);
    ItemsDefinition compiledItems = ItemsCompiler.INSTANCE.compile(body.items(), ctx);
    List<PipelineStateDefinition> compiledStates = body.states() != null
        ? body.states().stream()
            .map(state -> StateCompiler.INSTANCE.compile(state, ctx))
            .toList()
        : Collections.emptyList();

    List<PipelineStateDefinition.PipelineToolDefinition> compiledTools = body.tools() != null
        ? body.tools().stream()
            .map(tool -> ToolCompiler.INSTANCE.compile(tool, ctx))
            .toList()
        : Collections.emptyList();

    FallbackDefinition fallback = FallbackCompiler.INSTANCE.compile(body.fallback(), ctx);
    return PipelineBodyDefinition.builder()
        .variables(variables)
        .pipelineConfig(pipelineConfig)
        .source(compiledSource)
        .items(compiledItems)
        .states(compiledStates)
        .tools(compiledTools)
        .fallback(fallback)
        .build();
  }

  default void validate(PipelineManifest source) {
    if (source == null) {
      throw new IllegalArgumentException("Source can't be null");
    }

    if (source.body() == null) {
      return;
    }

    var body = source.body();
    boolean hasSource = body.source() != null && !body.source().isEmpty();
    boolean hasItems = body.items() != null && !body.items().isEmpty();
    boolean hasStates = body.states() != null && !body.states().isEmpty();
    boolean hasTools = body.tools() != null && !body.tools().isEmpty();

    if (hasStates || hasTools) {
      if (hasSource && hasItems) {
        throw new IllegalArgumentException(
            "Exactly one of 'source' or 'items' must be declared, not both");
      }
      if (!hasSource && !hasItems) {
        throw new IllegalArgumentException(
            "Pipeline with states or tools requires either 'source' or 'items' to process data");
      }
    }
  }
}
