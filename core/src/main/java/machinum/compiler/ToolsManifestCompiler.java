package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import machinum.definition.ToolDefinition;
import machinum.definition.ToolDefinition.ToolConfigDefinition;
import machinum.definition.ToolsDefinition;
import machinum.definition.ToolsDefinition.BootstrapToolDefinition;
import machinum.definition.ToolsDefinition.ToolsBodyDefinition;
import machinum.manifest.ToolsBody;
import machinum.manifest.ToolsBody.BootstrapToolManifest;
import machinum.manifest.ToolsBody.ToolConfigManifest;
import machinum.manifest.ToolsBody.ToolManifest;
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

  @Mapping(target = "registry", source = "registry", qualifiedByName = "compileString")
  @Mapping(target = "tools", source = "tools", qualifiedByName = "tools")
  @Mapping(target = "bootstrap", source = "bootstrap", qualifiedByName = "compileBootstrap")
  ToolsBodyDefinition compileToolsBody(ToolsBody source, @Context CompilationContext ctx);

  @Named("compileToolsBody")
  default ToolsBodyDefinition compileToolsBodyWrapper(
      ToolsBody source, @Context CompilationContext ctx) {
    return compileToolsBody(source, ctx);
  }

  @Named("compileBootstrap")
  default List<BootstrapToolDefinition> compileBootstrap(
      List<BootstrapToolManifest> source, @Context CompilationContext ctx) {
    if (source == null) {
      return Collections.emptyList();
    }
    return source.stream()
        .map(tool -> compileBootstrapTool(tool, ctx))
        .collect(Collectors.toList());
  }

  @Mapping(target = "name", source = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", source = "description", qualifiedByName = "compileString")
  @Mapping(target = "config", source = "config", qualifiedByName = "compileObjectMap")
  BootstrapToolDefinition compileBootstrapTool(
      BootstrapToolManifest source, @Context CompilationContext ctx);

  @Named("tools")
  default List<ToolDefinition> compileTools(
      List<ToolManifest> source, @Context CompilationContext ctx) {
    if (source == null) {
      return Collections.emptyList();
    }
    return source.stream()
        .map(tool -> compileCustomRegistryTool(tool, ctx))
        .collect(Collectors.toList());
  }

  @Mapping(target = "name", source = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", source = "description", qualifiedByName = "compileString")
  ToolDefinition compileCustomRegistryTool(ToolManifest source, @Context CompilationContext ctx);

  @Mapping(target = "params", source = "params", qualifiedByName = "compileObjectMap")
  ToolConfigDefinition compileToolConfig(
      ToolConfigManifest source, @Context CompilationContext ctx);
}
