package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import machinum.definition.ToolDefinition;
import machinum.definition.ToolDefinition.ToolConfigDefinition;
import machinum.definition.ToolsDefinition;
import machinum.definition.ToolsDefinition.ToolRegistryDefinition;
import machinum.definition.ToolsDefinition.ToolsBodyDefinition;
import machinum.manifest.ToolsBody;
import machinum.manifest.ToolsBody.ToolConfigManifest;
import machinum.manifest.ToolsBody.ToolManifest;
import machinum.manifest.ToolsBody.ToolRegistryConfigManifest;
import machinum.manifest.ToolsManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ToolsManifestCompiler extends YamlCompiler<ToolsManifest, ToolsDefinition> {

  ToolsManifestCompiler INSTANCE = Mappers.getMapper(ToolsManifestCompiler.class);

  @Mapping(target = "labels", source = "labels", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "metadata", source = "metadata", qualifiedByName = "compileSimpleMap")
  ToolsDefinition compile(ToolsManifest source, @Context CompilationContext ctx);

  @Mapping(target = "toolRegistry", source = "registry")
  @Mapping(target = "tools", source = "tools", qualifiedByName = "tools")
  @Mapping(target = "bootstrap", source = "bootstrap")
  ToolsBodyDefinition compileToolsBody(ToolsBody source, @Context CompilationContext ctx);

  ToolRegistryDefinition compileToolRegistry(
      ToolRegistryConfigManifest source, @Context CompilationContext ctx);

  @Mapping(target = "name", source = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", source = "description", qualifiedByName = "compileString")
  @Mapping(target = "type", source = "type", qualifiedByName = "compileString")
  @Mapping(
      target = "executionTarget",
      source = "executionTarget",
      qualifiedByName = "compileString")
  ToolDefinition compileInstalledTool(
      ToolManifest source, @Context CompilationContext ctx);

  @Mapping(target = "params", source = "params", qualifiedByName = "compileObjectMap")
  ToolConfigDefinition compileToolConfig(
      ToolConfigManifest source, @Context CompilationContext ctx);

  @Named("tools")
  default List<ToolDefinition> compileTools(
      List<ToolManifest> source, @Context CompilationContext ctx) {
    if (source == null) {
      return Collections.emptyList();
    }
    return source.stream()
        .map(tool -> compileInstalledTool(tool, ctx))
        .collect(Collectors.toList());
  }
}
