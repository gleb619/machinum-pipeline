package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.manifest.SourceManifest;

@Builder
public record SourceDefinition(
    Compiled<SourceManifest.Type> type,
    Compiled<String> fileLocation,
    Compiled<SourceManifest.Format> format,
    Compiled<String> customLoader,
    CompiledMap variables) {}
