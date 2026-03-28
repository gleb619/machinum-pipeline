package machinum.definition;

import lombok.Builder;
import machinum.compiler.Compiled;
import machinum.compiler.CompiledMap;
import machinum.manifest.ItemsManifest;

@Builder
public record ItemsDefinition(
    Compiled<ItemsManifest.Type> type, Compiled<String> customExtractor, CompiledMap variables) {}
