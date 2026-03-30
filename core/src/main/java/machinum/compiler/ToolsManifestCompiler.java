package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import machinum.definition.ToolDefinition;
import machinum.definition.ToolDefinition.ToolCacheDefinition;
import machinum.definition.ToolDefinition.ToolConfigDefinition;
import machinum.definition.ToolDefinition.ToolSourceDefinition;
import machinum.definition.ToolsDefinition;
import machinum.definition.ToolsDefinition.ExecutionTargetDefinition;
import machinum.definition.ToolsDefinition.ExecutionTargetsDefinition;
import machinum.definition.ToolsDefinition.ToolRegistryDefinition;
import machinum.definition.ToolsDefinition.ToolsBodyDefinition;
import machinum.manifest.ToolsBody;
import machinum.manifest.ToolsBody.ExecutionTargetManifest;
import machinum.manifest.ToolsBody.ExecutionTargetsManifest;
import machinum.manifest.ToolsBody.ToolCacheManifest;
import machinum.manifest.ToolsBody.ToolConfigManifest;
import machinum.manifest.ToolsBody.ToolDefinitionManifest;
import machinum.manifest.ToolsBody.ToolRegistryManifest;
import machinum.manifest.ToolsBody.ToolSourceManifest;
import machinum.manifest.ToolsManifest;
import org.mapstruct.Context;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.Named;
import org.mapstruct.factory.Mappers;

@Mapper(uses = CommonCompiler.class)
public interface ToolsManifestCompiler extends YamlCompiler<ToolsManifest, ToolsDefinition> {

  ToolsManifestCompiler INSTANCE = Mappers.getMapper(ToolsManifestCompiler.class);

  @Mapping(target = "version", source = "version")
  @Mapping(target = "type", source = "type")
  @Mapping(target = "name", source = "name")
  @Mapping(target = "description", source = "description")
  @Mapping(target = "labels", source = "labels", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "metadata", source = "metadata", qualifiedByName = "compileSimpleMap")
  @Mapping(target = "body", source = "body")
  ToolsDefinition compile(ToolsManifest source, @Context CompilationContext ctx);

  @Mapping(target = "tools", source = "tools", qualifiedByName = "tools")
  ToolsBodyDefinition compileToolsBody(ToolsBody source, @Context CompilationContext ctx);

  ToolRegistryDefinition compileToolRegistry(
      ToolRegistryManifest source, @Context CompilationContext ctx);

  @Mapping(target = "targets", source = "targets", qualifiedByName = "targets")
  ExecutionTargetsDefinition compileExecutionTargets(
      ExecutionTargetsManifest source, @Context CompilationContext ctx);

  ExecutionTargetDefinition compileExecutionTarget(
      ExecutionTargetManifest source, @Context CompilationContext ctx);

  @Mapping(target = "name", source = "name", qualifiedByName = "compileString")
  @Mapping(target = "description", source = "description", qualifiedByName = "compileString")
  @Mapping(target = "type", source = "type", qualifiedByName = "compileString")
  @Mapping(target = "version", source = "version", qualifiedByName = "compileString")
  @Mapping(
      target = "executionTarget",
      source = "executionTarget",
      qualifiedByName = "compileString")
  @Mapping(target = "timeout", source = "timeout", qualifiedByName = "compileString")
  ToolDefinition compileInstalledTool(
      ToolDefinitionManifest source, @Context CompilationContext ctx);

  ToolSourceDefinition compileToolSource(
      ToolSourceManifest source, @Context CompilationContext ctx);

  ToolCacheDefinition compileToolCache(ToolCacheManifest source, @Context CompilationContext ctx);

  ToolConfigDefinition compileToolConfig(
      ToolConfigManifest source, @Context CompilationContext ctx);

  @Named("tools")
  default List<ToolDefinition> compileTools(
      List<ToolDefinitionManifest> source, @Context CompilationContext ctx) {
    if (source == null) {
      return Collections.emptyList();
    }
    return source.stream()
        .map(tool -> compileInstalledTool(tool, ctx))
        .collect(Collectors.toList());
  }

  @Named("targets")
  default List<ExecutionTargetDefinition> compileTargets(
      List<ExecutionTargetManifest> source, @Context CompilationContext ctx) {
    if (source == null) {
      return Collections.emptyList();
    }
    return source.stream()
        .map(target -> compileExecutionTarget(target, ctx))
        .collect(Collectors.toList());
  }
}
