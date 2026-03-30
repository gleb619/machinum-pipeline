package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.PipelineStateDefinition.PipelineToolDefinition;
import machinum.manifest.ToolManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ToolCompiler extends YamlCompiler<ToolManifest, PipelineToolDefinition> {

  ToolCompiler INSTANCE = Mappers.getMapper(ToolCompiler.class);

  @Mapping(target = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", qualifiedByName = "compileString")
  @Mapping(target = "async", qualifiedByName = "compileConstant")
  @Mapping(target = "input", qualifiedByName = "compileString")
  @Mapping(target = "output", qualifiedByName = "compileString")
  @Mapping(target = "tools", source = "stateTools", qualifiedByName = "compileNestedTools")
  PipelineToolDefinition compile(ToolManifest source, @Context CompilationContext ctx);

  @Named("compileNestedTools")
  default List<PipelineToolDefinition> compileNestedTools(
      List<ToolManifest> tools, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(tools, Collections.<ToolManifest>emptyList()).stream()
        .map(tool -> compile(tool, ctx))
        .toList();
  }
}
