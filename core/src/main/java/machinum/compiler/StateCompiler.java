package machinum.compiler;

import java.util.Collections;
import java.util.List;
import java.util.Objects;
import machinum.definition.PipelineStateDefinition;
import machinum.definition.PipelineStateDefinition.ForkBranchDefinition;
import machinum.definition.PipelineStateDefinition.ForkDefinition;
import machinum.definition.PipelineStateDefinition.PipelineToolDefinition;
import machinum.definition.PipelineStateDefinition.WindowAggregationDefinition;
import machinum.definition.PipelineStateDefinition.WindowDefinition;
import machinum.manifest.PipelineStateManifest;
import machinum.manifest.PipelineStateManifest.ForkBranchManifest;
import machinum.manifest.PipelineStateManifest.ForkManifest;
import machinum.manifest.PipelineStateManifest.WindowAggregationManifest;
import machinum.manifest.PipelineStateManifest.WindowManifest;
import machinum.manifest.PipelineToolManifest;
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
  @Mapping(target = "waitFor", qualifiedByName = "compileString")
  @Mapping(target = "tools", qualifiedByName = "compileStateTools")
  PipelineStateDefinition compile(PipelineStateManifest source, @Context CompilationContext ctx);

  @Mapping(target = "type", qualifiedByName = "compileString")
  @Mapping(target = "size", qualifiedByName = "compileString")
  WindowDefinition compileWindow(WindowManifest source, @Context CompilationContext ctx);

  @Mapping(target = "groupBy", qualifiedByName = "compileString")
  @Mapping(target = "output", qualifiedByName = "compileString")
  @Mapping(target = "tools", qualifiedByName = "compileStateTools")
  WindowAggregationDefinition compileAggregation(
      WindowAggregationManifest source, @Context CompilationContext ctx);

  @Mapping(target = "branches", qualifiedByName = "compileBranches")
  ForkDefinition compileFork(ForkManifest source, @Context CompilationContext ctx);

  @Named("compileBranches")
  default List<ForkBranchDefinition> compileBranches(
      List<ForkBranchManifest> branches, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(branches, Collections.<ForkBranchManifest>emptyList())
        .stream()
        .map(branch -> compileBranch(branch, ctx))
        .toList();
  }

  @Mapping(target = "name", qualifiedByName = "compileString")
  @Mapping(target = "states", qualifiedByName = "compileNestedStates")
  ForkBranchDefinition compileBranch(ForkBranchManifest source, @Context CompilationContext ctx);

  @Named("compileNestedStates")
  default List<PipelineStateDefinition> compileNestedStates(
      List<PipelineStateManifest> states, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(states, Collections.<PipelineStateManifest>emptyList())
        .stream()
        .map(state -> compile(state, ctx))
        .toList();
  }

  @Named("compileStateTools")
  default List<PipelineToolDefinition> compileStateTools(
      List<PipelineToolManifest> tools, @Context CompilationContext ctx) {
    return Objects.requireNonNullElse(tools, Collections.<PipelineToolManifest>emptyList()).stream()
        .map(tool -> ToolCompiler.INSTANCE.compile(tool, ctx))
        .toList();
  }
}
