import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { MediaInputPathToUrlPreprocessor } from "../../../../../src/agent-customization/processors/tool-invocation/media-input-path-to-url-preprocessor.js";
import { ToolInvocation } from "autobyteus-ts/agent/tool-invocation.js";
import { FileSystemWorkspace } from "../../../../../src/workspaces/filesystem-workspace.js";
import { WorkspaceConfig } from "autobyteus-ts/agent/workspace/workspace-config.js";
const mockMediaStorage = vi.hoisted(() => ({
    ingestLocalFileForContext: vi.fn(),
}));
vi.mock("../../../../../src/services/media-storage-service.js", () => {
    class MockMediaStorageService {
        ingestLocalFileForContext = mockMediaStorage.ingestLocalFileForContext;
    }
    return {
        MediaStorageService: MockMediaStorageService,
    };
});
describe("MediaInputPathToUrlPreprocessor", () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        mockMediaStorage.ingestLocalFileForContext.mockReset();
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });
    it("skips non-target tools", async () => {
        process.env.DEFAULT_IMAGE_GENERATION_MODEL = "rpa-model";
        const processor = new MediaInputPathToUrlPreprocessor();
        const invocation = new ToolInvocation("other_tool", { input_images: "foo.png" }, "1");
        const context = { agentId: "agent-1" };
        const result = await processor.process(invocation, context);
        expect(result).toBe(invocation);
        expect(mockMediaStorage.ingestLocalFileForContext).not.toHaveBeenCalled();
    });
    it("skips when model is not RPA", async () => {
        process.env.DEFAULT_IMAGE_GENERATION_MODEL = "gpt-4";
        const processor = new MediaInputPathToUrlPreprocessor();
        const invocation = new ToolInvocation("generate_image", { input_images: "foo.png" }, "2");
        const context = { agentId: "agent-1" };
        const result = await processor.process(invocation, context);
        expect(result).toBe(invocation);
        expect(mockMediaStorage.ingestLocalFileForContext).not.toHaveBeenCalled();
    });
    it("normalizes input_images with workspace", async () => {
        process.env.DEFAULT_IMAGE_GENERATION_MODEL = "rpa-model";
        mockMediaStorage.ingestLocalFileForContext.mockResolvedValue("http://server/file.png");
        const processor = new MediaInputPathToUrlPreprocessor();
        const invocation = new ToolInvocation("generate_image", { input_images: "images/out.png" }, "3");
        const workspace = new FileSystemWorkspace(new WorkspaceConfig({ rootPath: "/tmp" }));
        const context = { agentId: "agent-1", workspace };
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const statSpy = vi.spyOn(fs, "statSync").mockReturnValue({
            isFile: () => true,
        });
        const result = await processor.process(invocation, context);
        expect(mockMediaStorage.ingestLocalFileForContext).toHaveBeenCalledWith("/tmp/images/out.png");
        expect(result.arguments.input_images).toBe("http://server/file.png");
        existsSpy.mockRestore();
        statSpy.mockRestore();
    });
    it("keeps URL entries unchanged", async () => {
        process.env.DEFAULT_IMAGE_GENERATION_MODEL = "rpa-model";
        const processor = new MediaInputPathToUrlPreprocessor();
        const invocation = new ToolInvocation("generate_image", { input_images: "http://example.com/img.png" }, "4");
        const context = { agentId: "agent-1" };
        const result = await processor.process(invocation, context);
        expect(result.arguments.input_images).toBe("http://example.com/img.png");
        expect(mockMediaStorage.ingestLocalFileForContext).not.toHaveBeenCalled();
    });
    it("normalizes mask_image when present", async () => {
        process.env.DEFAULT_IMAGE_EDIT_MODEL = "rpa-model";
        mockMediaStorage.ingestLocalFileForContext.mockResolvedValue("http://server/mask.png");
        const processor = new MediaInputPathToUrlPreprocessor();
        const invocation = new ToolInvocation("edit_image", { mask_image: "mask.png" }, "5");
        const workspace = new FileSystemWorkspace(new WorkspaceConfig({ rootPath: "/tmp" }));
        const context = { agentId: "agent-1", workspace };
        const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
        const statSpy = vi.spyOn(fs, "statSync").mockReturnValue({
            isFile: () => true,
        });
        const result = await processor.process(invocation, context);
        expect(mockMediaStorage.ingestLocalFileForContext).toHaveBeenCalledWith("/tmp/mask.png");
        expect(result.arguments.mask_image).toBe("http://server/mask.png");
        existsSpy.mockRestore();
        statSpy.mockRestore();
    });
});
