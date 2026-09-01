/// <reference types="vite/client" />

// highlight.js 主题以字符串形式导入（Vite 的 ?inline 查询）
declare module "*.css?inline" {
  const css: string;
  export default css;
}

// markdown-it-task-lists 没有官方类型声明
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const plugin: (md: MarkdownIt, options?: TaskListsOptions) => void;
  export default plugin;
}
