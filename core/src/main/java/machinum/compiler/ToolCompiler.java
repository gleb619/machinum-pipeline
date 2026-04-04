package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.PipelineStateDefinition.PipelineToolDefinition;
import machinum.manifest.PipelineToolManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ToolCompiler extends YamlCompiler<PipelineToolManifest, PipelineToolDefinition> {

  ToolCompiler INSTANCE = Mappers.getMapper(ToolCompiler.class);

  @Mapping(target = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", qualifiedByName = "compileString")
  @Mapping(target = "async", qualifiedByName = "compile")
  @Mapping(target = "input", qualifiedByName = "compileString")
  @Mapping(target = "output", qualifiedByName = "compileString")
  @Mapping(target = "tools", qualifiedByName = "compileNestedTools")
  PipelineToolDefinition compile(PipelineToolManifest source, @Context CompilationContext ctx);

  @Named("compileNestedTools")
  default List<PipelineToolDefinition> compileNestedTools(
      List<PipelineToolManifest> tools, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(tools, Collections.<PipelineToolManifest>emptyList()).stream()
        .map(tool -> compile(tool, ctx))
        .toList();
  }
}
