package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.PipelineStateDefinition;
import machinum.definition.ToolDefinition;
import machinum.manifest.PipelineStateManifest;
import machinum.manifest.ToolManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = {CommonCompiler.class, ToolCompiler.class})
public interface StateCompiler
    extends YamlCompiler<PipelineStateManifest, PipelineStateDefinition> {

  StateCompiler INSTANCE = Mappers.getMapper(StateCompiler.class);

  @Mapping(target = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", qualifiedByName = "compileString")
  @Mapping(target = "condition", qualifiedByName = "compileString")
  @Mapping(target = "stateTools", qualifiedByName = "compileStateTools")
  PipelineStateDefinition compile(PipelineStateManifest source, @Context CompilationContext ctx);

  @Named("compileStateTools")
  default List<ToolDefinition> compileStateTools(
      List<ToolManifest> tools, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(tools, Collections.<ToolManifest>emptyList()).stream()
        .map(tool -> ToolCompiler.INSTANCE.compile(tool, ctx))
        .toList();
  }
}
