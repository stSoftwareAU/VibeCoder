// Ported from js-yaml v3.13.1:
// https://github.com/nodeca/js-yaml/commit/665aadda42349dcae869f12040d9b10ef18d12da
// Copyright 2011-2015 by Vitaly Puzrin. All rights reserved. MIT license.
// Copyright 2018-2026 the Deno authors. MIT license.
export const nil = {
  tag: "tag:yaml.org,2002:null",
  kind: "scalar",
  defaultStyle: "lowercase",
  predicate: (object)=>object === null,
  construct: ()=>null,
  resolve: (data)=>{
    return data === "~" || data === "null" || data === "Null" || data === "NULL";
  },
  represent: {
    lowercase: ()=>"null",
    uppercase: ()=>"NULL",
    camelcase: ()=>"Null"
  }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImh0dHBzOi8vanNyLmlvL0BzdGQveWFtbC8xLjAuMTIvX3R5cGUvbmlsLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vIFBvcnRlZCBmcm9tIGpzLXlhbWwgdjMuMTMuMTpcbi8vIGh0dHBzOi8vZ2l0aHViLmNvbS9ub2RlY2EvanMteWFtbC9jb21taXQvNjY1YWFkZGE0MjM0OWRjYWU4NjlmMTIwNDBkOWIxMGVmMThkMTJkYVxuLy8gQ29weXJpZ2h0IDIwMTEtMjAxNSBieSBWaXRhbHkgUHV6cmluLiBBbGwgcmlnaHRzIHJlc2VydmVkLiBNSVQgbGljZW5zZS5cbi8vIENvcHlyaWdodCAyMDE4LTIwMjYgdGhlIERlbm8gYXV0aG9ycy4gTUlUIGxpY2Vuc2UuXG5cbmltcG9ydCB0eXBlIHsgVHlwZSB9IGZyb20gXCIuLi9fdHlwZS50c1wiO1xuXG5leHBvcnQgY29uc3QgbmlsOiBUeXBlPFwic2NhbGFyXCIsIG51bGw+ID0ge1xuICB0YWc6IFwidGFnOnlhbWwub3JnLDIwMDI6bnVsbFwiLFxuICBraW5kOiBcInNjYWxhclwiLFxuICBkZWZhdWx0U3R5bGU6IFwibG93ZXJjYXNlXCIsXG4gIHByZWRpY2F0ZTogKG9iamVjdDogdW5rbm93bik6IG9iamVjdCBpcyBudWxsID0+IG9iamVjdCA9PT0gbnVsbCxcbiAgY29uc3RydWN0OiAoKSA9PiBudWxsLFxuICByZXNvbHZlOiAoZGF0YTogc3RyaW5nKTogYm9vbGVhbiA9PiB7XG4gICAgcmV0dXJuIChcbiAgICAgIGRhdGEgPT09IFwiflwiIHx8XG4gICAgICBkYXRhID09PSBcIm51bGxcIiB8fFxuICAgICAgZGF0YSA9PT0gXCJOdWxsXCIgfHxcbiAgICAgIGRhdGEgPT09IFwiTlVMTFwiXG4gICAgKTtcbiAgfSxcbiAgcmVwcmVzZW50OiB7XG4gICAgbG93ZXJjYXNlOiAoKTogc3RyaW5nID0+IFwibnVsbFwiLFxuICAgIHVwcGVyY2FzZTogKCk6IHN0cmluZyA9PiBcIk5VTExcIixcbiAgICBjYW1lbGNhc2U6ICgpOiBzdHJpbmcgPT4gXCJOdWxsXCIsXG4gIH0sXG59O1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLCtCQUErQjtBQUMvQixvRkFBb0Y7QUFDcEYsMEVBQTBFO0FBQzFFLHFEQUFxRDtBQUlyRCxPQUFPLE1BQU0sTUFBNEI7RUFDdkMsS0FBSztFQUNMLE1BQU07RUFDTixjQUFjO0VBQ2QsV0FBVyxDQUFDLFNBQW9DLFdBQVc7RUFDM0QsV0FBVyxJQUFNO0VBQ2pCLFNBQVMsQ0FBQztJQUNSLE9BQ0UsU0FBUyxPQUNULFNBQVMsVUFDVCxTQUFTLFVBQ1QsU0FBUztFQUViO0VBQ0EsV0FBVztJQUNULFdBQVcsSUFBYztJQUN6QixXQUFXLElBQWM7SUFDekIsV0FBVyxJQUFjO0VBQzNCO0FBQ0YsRUFBRSJ9
// denoCacheMetadata=11093995637642155722,2492730545960227170