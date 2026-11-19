#!/usr/bin/env python3
"""
AutoPatch Real Python 3.11 AST, Symbol-Table & Static Security Analyzer.
Uses Python's built-in ast, symtable, importlib, and difflib modules (plus ruff/bandit if installed)
to detect genuine syntax, name, import, call, arithmetic, loop, exception, and security bugs
without fabricating issues on valid code.
"""
import ast
import builtins
import difflib
import importlib.util
import json
import shutil
import subprocess
import symtable
import sys
from pathlib import Path
from typing import Any


BUILTIN_NAMES = set(dir(builtins)) | {
    "__name__",
    "__file__",
    "__doc__",
    "__package__",
    "__spec__",
    "__annotations__",
    "__builtins__",
}


def extract_target_names(target: ast.AST) -> list[str]:
    names: list[str] = []
    if isinstance(target, ast.Name):
        names.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for elt in target.elts:
            names.extend(extract_target_names(elt))
    elif isinstance(target, ast.Starred):
        names.extend(extract_target_names(target.value))
    return names


class DirectScopeCollector(ast.NodeVisitor):
    """Collects names bound directly in a function body WITHOUT descending into nested defs/classes/lambdas/comprehensions."""

    def __init__(self) -> None:
        self.assigned: set[str] = set()
        self.globals_or_nonlocals: set[str] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        self.assigned.add(node.name)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self.assigned.add(node.name)

    def visit_ClassDef(self, node: ast.ClassDef):
        self.assigned.add(node.name)

    def visit_Lambda(self, node: ast.Lambda):
        return

    def visit_ListComp(self, node: ast.ListComp):
        return

    def visit_SetComp(self, node: ast.SetComp):
        return

    def visit_DictComp(self, node: ast.DictComp):
        return

    def visit_GeneratorExp(self, node: ast.GeneratorExp):
        return

    def visit_Assign(self, node: ast.Assign):
        for t in node.targets:
            self.assigned.update(extract_target_names(t))
        self.visit(node.value)

    def visit_AugAssign(self, node: ast.AugAssign):
        self.assigned.update(extract_target_names(node.target))
        self.visit(node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign):
        if node.value is not None:
            self.assigned.update(extract_target_names(node.target))
            self.visit(node.value)

    def visit_For(self, node: ast.For):
        self.assigned.update(extract_target_names(node.target))
        self.generic_visit(node)

    def visit_AsyncFor(self, node: ast.AsyncFor):
        self.assigned.update(extract_target_names(node.target))
        self.generic_visit(node)

    def visit_With(self, node: ast.With):
        for item in node.items:
            if item.optional_vars is not None:
                self.assigned.update(extract_target_names(item.optional_vars))
        self.generic_visit(node)

    def visit_AsyncWith(self, node: ast.AsyncWith):
        for item in node.items:
            if item.optional_vars is not None:
                self.assigned.update(extract_target_names(item.optional_vars))
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler):
        if node.name:
            self.assigned.add(node.name)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            self.assigned.add(alias.asname or alias.name.split(".")[0])

    def visit_ImportFrom(self, node: ast.ImportFrom):
        for alias in node.names:
            if alias.name != "*":
                self.assigned.add(alias.asname or alias.name)

    def visit_Global(self, node: ast.Global):
        self.globals_or_nonlocals.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal):
        self.globals_or_nonlocals.update(node.names)

    def visit_NamedExpr(self, node: ast.NamedExpr):
        self.assigned.update(extract_target_names(node.target))
        self.visit(node.value)


class ScopeAnalyzer(ast.NodeVisitor):
    def __init__(self, source_lines: list[str], rel_path: str, project_root: Path | None = None):
        self.lines = source_lines
        self.rel_path = rel_path
        self.project_root = project_root
        self.findings: list[dict[str, Any]] = []
        self.scope_stack: list[set[str]] = [set(BUILTIN_NAMES)]
        self.imported_names: dict[str, int] = {}
        self.used_names: set[str] = set()
        self.top_level_funcs: dict[str, dict[str, Any]] = {}
        self.seen_keys: set[tuple[str, int]] = set()
        self.current_function_assigned_so_far: list[set[str] | None] = [None]

    def add_finding(
        self,
        title: str,
        description: str,
        category: str,
        severity: str,
        confidence: float,
        start_line: int,
        end_line: int,
        evidence: str,
        root_cause: str,
        why_it_occurs: str,
        triggering_condition: str,
        expected_behavior: str,
        actual_behavior: str,
        potential_impact: str,
        suggested_solution: str,
        analyzer_source: str = "Python 3.11 AST",
    ):
        key = (title, start_line)
        if key in self.seen_keys:
            return
        self.seen_keys.add(key)

        s_idx = max(0, start_line - 1)
        e_idx = min(len(self.lines), max(start_line, end_line))
        snippet = "\n".join(self.lines[s_idx:e_idx]) if self.lines else ""
        self.findings.append(
            {
                "bug_title": title,
                "bug_description": description,
                "bug_category": category,
                "severity": severity,
                "confidence_score": confidence,
                "analyzer_source": analyzer_source,
                "evidence": evidence,
                "file_path": self.rel_path,
                "start_line": start_line,
                "end_line": end_line,
                "original_code": snippet,
                "root_cause": root_cause,
                "why_it_occurs": why_it_occurs,
                "triggering_condition": triggering_condition,
                "expected_behavior": expected_behavior,
                "actual_behavior": actual_behavior,
                "potential_impact": potential_impact,
                "suggested_solution": suggested_solution,
            }
        )

    def current_defined(self) -> set[str]:
        combined: set[str] = set()
        for scope in self.scope_stack:
            combined |= scope
        return combined

    def define_target(self, target: ast.AST, is_comprehension: bool = False):
        names = extract_target_names(target)
        if is_comprehension:
            self.scope_stack[-1].update(names)
        else:
            self.scope_stack[-1].update(names)
            if self.current_function_assigned_so_far[-1] is not None:
                self.current_function_assigned_so_far[-1].update(names)

    def _module_exists(self, module_name: str, level: int = 0) -> bool:
        if level > 0:
            if self.project_root is None:
                return True
            base_dir = (self.project_root / self.rel_path).parent
            for _ in range(level - 1):
                base_dir = base_dir.parent
            if not module_name:
                return (base_dir / "__init__.py").exists()
            rel_mod = Path(*module_name.split("."))
            return (base_dir / f"{rel_mod}.py").exists() or (base_dir / rel_mod / "__init__.py").exists()

        top = module_name.split(".")[0]
        if top in sys.stdlib_module_names or top in sys.builtin_module_names:
            return True
        if self.project_root is not None:
            if (self.project_root / f"{top}.py").exists() or (self.project_root / top / "__init__.py").exists():
                return True
            rel_dir = (self.project_root / self.rel_path).parent
            if (rel_dir / f"{top}.py").exists() or (rel_dir / top / "__init__.py").exists():
                return True
        try:
            return importlib.util.find_spec(top) is not None
        except (ModuleNotFoundError, ValueError, AttributeError):
            return False

    def visit_Module(self, node: ast.Module):
        # Pre-register top-level module function/class names & signatures so forward references and calls work
        for stmt in node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.scope_stack[0].add(stmt.name)
                pos_args = stmt.args.posonlyargs + stmt.args.args
                defaults_count = len(stmt.args.defaults)
                min_pos = len(pos_args) - defaults_count
                max_pos = len(pos_args)
                all_param_names = {a.arg for a in pos_args + stmt.args.kwonlyargs}
                kw_defaults_missing = {
                    a.arg
                    for a, d in zip(stmt.args.kwonlyargs, stmt.args.kw_defaults)
                    if d is None
                }
                self.top_level_funcs[stmt.name] = {
                    "min_pos": min_pos,
                    "max_pos": max_pos,
                    "has_vararg": stmt.args.vararg is not None,
                    "has_kwarg": stmt.args.kwarg is not None,
                    "param_names": all_param_names,
                    "required_kwonly": kw_defaults_missing,
                }
            elif isinstance(stmt, ast.ClassDef):
                self.scope_stack[0].add(stmt.name)
        self.generic_visit(node)

    def visit_Import(self, node: ast.Import):
        for alias in node.names:
            bound = alias.asname or alias.name.split(".")[0]
            self.scope_stack[-1].add(bound)
            self.imported_names[bound] = node.lineno
            if not self._module_exists(alias.name, level=0):
                self.add_finding(
                    title=f"Missing or unresolvable module '{alias.name}'",
                    description=f"Imported module '{alias.name}' could not be found in Python stdlib, installed packages, or project directory.",
                    category="Import Error",
                    severity="High",
                    confidence=0.92,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"import {alias.name} at line {node.lineno}: module not found via importlib.util.find_spec or local project files.",
                    root_cause=f"Dependency '{alias.name}' is not installed in the Python environment and does not exist in the project workspace.",
                    why_it_occurs="Missing package dependency, misspelled module name, or incomplete requirements installation.",
                    triggering_condition=f"Importing {self.rel_path} executes line {node.lineno}.",
                    expected_behavior=f"Module '{alias.name}' resolves cleanly at import time.",
                    actual_behavior=f"Raises ModuleNotFoundError: No module named '{alias.name.split('.')[0]}'.",
                    potential_impact="Module fails to load or execute.",
                    suggested_solution=f"Install '{alias.name.split('.')[0]}', verify the module name spelling, or include the missing module file in the project.",
                )

    def visit_ImportFrom(self, node: ast.ImportFrom):
        if node.module and not self._module_exists(node.module, level=node.level):
            self.add_finding(
                title=f"Missing or unresolvable module '{node.module}'",
                description=f"Module '{node.module}' referenced in 'from {node.module} import ...' could not be resolved.",
                category="Import Error",
                severity="High",
                confidence=0.92,
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
                evidence=f"from {'.' * node.level}{node.module} import ... at line {node.lineno} could not be resolved.",
                root_cause=f"Target module '{node.module}' does not exist in the project directory, stdlib, or installed packages.",
                why_it_occurs="Missing dependency, wrong relative path, or typo in module name.",
                triggering_condition=f"Importing {self.rel_path} executes line {node.lineno}.",
                expected_behavior=f"Module '{node.module}' imports cleanly.",
                actual_behavior=f"Raises ModuleNotFoundError at runtime.",
                potential_impact="Module cannot be imported.",
                suggested_solution=f"Verify module path/spelling for '{node.module}' or add the missing package/file.",
            )
        for alias in node.names:
            if alias.name == "*":
                continue
            bound = alias.asname or alias.name
            self.scope_stack[-1].add(bound)
            self.imported_names[bound] = node.lineno

    def visit_ClassDef(self, node: ast.ClassDef):
        for dec in node.decorator_list:
            self.visit(dec)
        for base in node.bases:
            self.visit(base)
        for kw in node.keywords:
            self.visit(kw.value)
        self.scope_stack[-1].add(node.name)
        self.scope_stack.append(set())
        self.current_function_assigned_so_far.append(None)
        for stmt in node.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                self.scope_stack[-1].add(stmt.name)
        for stmt in node.body:
            self.visit(stmt)
        self.current_function_assigned_so_far.pop()
        self.scope_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef):
        for dec in node.decorator_list:
            self.visit(dec)
        for dflt in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
            self.visit(dflt)
            if isinstance(dflt, (ast.List, ast.Dict, ast.Set)):
                self.add_finding(
                    title=f"Mutable default argument in '{node.name}()'",
                    description=f"Function '{node.name}' uses a mutable {type(dflt).__name__.lower()} literal as a default parameter value.",
                    category="Logic Error",
                    severity="Medium",
                    confidence=0.95,
                    start_line=node.lineno,
                    end_line=node.lineno,
                    evidence=f"AST FunctionDef '{node.name}' has mutable default {ast.dump(dflt)} at line {node.lineno}.",
                    root_cause="Python evaluates default argument objects once at function definition time, sharing the same mutable container across calls.",
                    why_it_occurs="Default value is a literal list, dict, or set instead of None.",
                    triggering_condition=f"Calling {node.name}() multiple times without explicitly passing that argument.",
                    expected_behavior="Each call starts with a fresh independent collection.",
                    actual_behavior="Mutations persist across subsequent invocations.",
                    potential_impact="Subtle state leakage between calls.",
                    suggested_solution="Use `None` as the default value and initialize the collection inside the function body (`if arg is None: arg = []`).",
                )

        self.scope_stack[-1].add(node.name)

        param_names: set[str] = set()
        for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            param_names.add(arg.arg)
        if node.args.vararg:
            param_names.add(node.args.vararg.arg)
        if node.args.kwarg:
            param_names.add(node.args.kwarg.arg)

        collector = DirectScopeCollector()
        for stmt in node.body:
            collector.visit(stmt)

        # In Python, any local assigned in the function is local throughout the function (unless declared global/nonlocal)
        all_declared_locals = param_names | (collector.assigned - collector.globals_or_nonlocals)
        self.scope_stack.append(all_declared_locals)
        self.current_function_assigned_so_far.append(set(param_names) | collector.globals_or_nonlocals)

        self._check_unreachable(node.body)
        for stmt in node.body:
            self.visit(stmt)

        self.current_function_assigned_so_far.pop()
        self.scope_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):
        self.visit_FunctionDef(node)  # type: ignore[arg-type]

    def visit_Lambda(self, node: ast.Lambda):
        for dflt in node.args.defaults + [d for d in node.args.kw_defaults if d is not None]:
            self.visit(dflt)
        args = {a.arg for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs}
        if node.args.vararg:
            args.add(node.args.vararg.arg)
        if node.args.kwarg:
            args.add(node.args.kwarg.arg)
        self.scope_stack.append(args)
        self.current_function_assigned_so_far.append(None)
        self.visit(node.body)
        self.current_function_assigned_so_far.pop()
        self.scope_stack.pop()

    def _visit_comprehension_generators(self, generators: list[ast.comprehension], body_nodes: list[ast.AST]):
        self.scope_stack.append(set())
        self.current_function_assigned_so_far.append(None)
        for gen in generators:
            self.visit(gen.iter)
            self.define_target(gen.target, is_comprehension=True)
            for cond in gen.ifs:
                self.visit(cond)
        for bn in body_nodes:
            self.visit(bn)
        self.current_function_assigned_so_far.pop()
        self.scope_stack.pop()

    def visit_ListComp(self, node: ast.ListComp):
        self._visit_comprehension_generators(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp):
        self._visit_comprehension_generators(node.generators, [node.elt])

    def visit_GeneratorExp(self, node: ast.GeneratorExp):
        self._visit_comprehension_generators(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp):
        self._visit_comprehension_generators(node.generators, [node.key, node.value])

    def visit_Assign(self, node: ast.Assign):
        self.visit(node.value)
        for t in node.targets:
            self._visit_target_subexpressions(t)
            self.define_target(t)

    def visit_AugAssign(self, node: ast.AugAssign):
        # AugAssign reads target before writing it
        if isinstance(node.target, ast.Name):
            self._check_name_read(node.target)
        else:
            self.visit(node.target)
        self.visit(node.value)
        self.define_target(node.target)

    def visit_AnnAssign(self, node: ast.AnnAssign):
        if node.value is not None:
            self.visit(node.value)
            self.define_target(node.target)
        else:
            self._visit_target_subexpressions(node.target)

    def visit_NamedExpr(self, node: ast.NamedExpr):
        self.visit(node.value)
        self.define_target(node.target)

    def _visit_target_subexpressions(self, target: ast.AST):
        if isinstance(target, ast.Subscript):
            self.visit(target.value)
            self.visit(target.slice)
        elif isinstance(target, ast.Attribute):
            self.visit(target.value)
        elif isinstance(target, (ast.Tuple, ast.List)):
            for elt in target.elts:
                self._visit_target_subexpressions(elt)

    def visit_With(self, node: ast.With):
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars is not None:
                self.define_target(item.optional_vars)
        self._check_unreachable(node.body)
        for stmt in node.body:
            self.visit(stmt)

    def visit_AsyncWith(self, node: ast.AsyncWith):
        self.visit_With(node)  # type: ignore[arg-type]

    def visit_For(self, node: ast.For):
        self.visit(node.iter)
        self.define_target(node.target)
        if isinstance(node.iter, ast.Call) and isinstance(node.iter.func, ast.Name) and node.iter.func.id == "range":
            for arg in node.iter.args:
                if isinstance(arg, ast.BinOp) and isinstance(arg.op, ast.Add):
                    if self._contains_len_call(arg.left) and isinstance(arg.right, ast.Constant) and arg.right.value == 1:
                        self.add_finding(
                            title="Incorrect loop condition (off-by-one index bound)",
                            description="Loop iterates with range(len(...) + 1), exceeding valid 0-based collection bounds.",
                            category="Logic Error",
                            severity="High",
                            confidence=0.95,
                            start_line=node.lineno,
                            end_line=getattr(node, "end_lineno", node.lineno),
                            evidence=f"AST For loop uses range(len(...) + 1) at line {node.lineno}.",
                            root_cause="Using len(sequence) + 1 as the upper bound in range() causes the loop counter to reach index len(sequence).",
                            why_it_occurs="Python sequences are 0-indexed, so valid indices span 0 to len(sequence) - 1.",
                            triggering_condition="Any sequence indexed by the loop counter inside this loop.",
                            expected_behavior="Loop iterates within 0..len(sequence)-1 without exceeding bounds.",
                            actual_behavior="Final iteration accesses index len(sequence), raising IndexError.",
                            potential_impact="Runtime IndexError crash during iteration.",
                            suggested_solution="Replace range(len(items) + 1) with range(len(items)) or iterate directly over elements.",
                        )
        self._check_unreachable(node.body)
        for s in node.body:
            self.visit(s)
        for s in node.orelse:
            self.visit(s)

    def visit_While(self, node: ast.While):
        self.visit(node.test)
        if isinstance(node.test, ast.Constant) and node.test.value is True:
            has_exit = any(
                isinstance(sub, (ast.Break, ast.Return, ast.Raise, ast.Yield, ast.YieldFrom))
                for sub in ast.walk(node)
            )
            if not has_exit:
                self.add_finding(
                    title="Potential infinite loop (while True without exit)",
                    description="Loop 'while True:' contains no break, return, raise, or yield statement.",
                    category="Logic Error",
                    severity="High",
                    confidence=0.91,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST While(test=True) at line {node.lineno} has no static control-flow exit.",
                    root_cause="Loop condition is always True and the body lacks any reachable exit path.",
                    why_it_occurs="Missing break condition or return inside loop.",
                    triggering_condition="Entering the while True loop.",
                    expected_behavior="Loop terminates cleanly via break, return, or bounded iteration.",
                    actual_behavior="Execution loops indefinitely and can hang or time out.",
                    potential_impact="CPU exhaustion and process timeout.",
                    suggested_solution="Add a terminating condition or break/return statement inside the loop.",
                )
        self._check_unreachable(node.body)
        for s in node.body:
            self.visit(s)
        for s in node.orelse:
            self.visit(s)

    def visit_Compare(self, node: ast.Compare):
        if len(node.ops) == 1 and len(node.comparators) == 1:
            left, op, right = node.left, node.ops[0], node.comparators[0]
            if isinstance(left, ast.Name) and isinstance(right, ast.Name) and left.id == right.id:
                if isinstance(op, (ast.Eq, ast.NotEq, ast.Lt, ast.Gt, ast.Is, ast.IsNot)):
                    self.add_finding(
                        title=f"Tautological or contradictory self-comparison on '{left.id}'",
                        description=f"Expression compares '{left.id}' against itself at line {node.lineno}.",
                        category="Logic Error",
                        severity="Medium",
                        confidence=0.95,
                        start_line=node.lineno,
                        end_line=getattr(node, "end_lineno", node.lineno),
                        evidence=f"AST Compare compares identical identifier '{left.id}' on both sides at line {node.lineno}.",
                        root_cause="Left and right operands refer to the same variable name, typically due to a variable typo.",
                        why_it_occurs="Misspelled variable name in comparison.",
                        triggering_condition=f"Evaluating condition at line {node.lineno}.",
                        expected_behavior="Compare two distinct variables or values.",
                        actual_behavior="Comparison always evaluates to a constant boolean.",
                        potential_impact="Incorrect branching behavior.",
                        suggested_solution="Check whether one side was meant to reference a different variable.",
                    )
        self.generic_visit(node)

    def _check_name_read(self, node: ast.Name):
        self.used_names.add(node.id)
        defined = self.current_defined()
        if node.id not in defined:
            close = difflib.get_close_matches(node.id, [n for n in defined if not n.startswith("__")], n=2, cutoff=0.72)
            hint = f" Closest defined identifier in scope: '{close[0]}'." if close else ""
            fix_hint = (
                f"Replace misspelled reference '{node.id}' with '{close[0]}' on line {node.lineno}."
                if close
                else f"Initialize or import '{node.id}' before referencing it on line {node.lineno}."
            )
            self.add_finding(
                title=f"Undefined variable '{node.id}'",
                description=f"Identifier '{node.id}' is referenced before assignment or import in this scope.{hint}",
                category="Name Error",
                severity="High" if close else "Medium",
                confidence=0.97 if close else 0.94,
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
                evidence=f"AST Name(ctx=Load, id='{node.id}') not found in lexical scope or builtins at line {node.lineno}.{hint}",
                root_cause=f"Variable '{node.id}' is read without being defined as a parameter, local variable, global, or import.{hint}",
                why_it_occurs=(
                    f"Identifier typo ('{node.id}' instead of '{close[0]}')."
                    if close
                    else "Typo in identifier name or missing variable initialization prior to reference."
                ),
                triggering_condition=f"Executing line {node.lineno} where '{node.id}' is evaluated.",
                expected_behavior=f"'{close[0] if close else node.id}' resolves to a defined variable or parameter.",
                actual_behavior=f"Python raises NameError: name '{node.id}' is not defined.",
                potential_impact="Immediate runtime NameError crash whenever this code path executes.",
                suggested_solution=fix_hint,
            )
            return

        # Check use-before-assignment inside the current function scope
        assigned_so_far = self.current_function_assigned_so_far[-1]
        if assigned_so_far is not None:
            current_fn_scope = self.scope_stack[-1]
            if node.id in current_fn_scope and node.id not in assigned_so_far:
                self.add_finding(
                    title=f"Variable '{node.id}' referenced before assignment",
                    description=f"Local variable '{node.id}' is read at line {node.lineno} before it is assigned later in the function.",
                    category="Name Error",
                    severity="High",
                    confidence=0.91,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"Local '{node.id}' is assigned later in the function but loaded at line {node.lineno}.",
                    root_cause=f"Python treats '{node.id}' as a local variable across the whole function because it is assigned inside the body, causing UnboundLocalError when read beforehand.",
                    why_it_occurs="Variable read occurs prior to its assignment or missing `global`/`nonlocal` declaration.",
                    triggering_condition=f"Executing line {node.lineno} before the assignment to '{node.id}'.",
                    expected_behavior=f"'{node.id}' is assigned before being read.",
                    actual_behavior=f"Raises UnboundLocalError: cannot access local variable '{node.id}'.",
                    potential_impact="Runtime crash when calling this function.",
                    suggested_solution=f"Initialize '{node.id}' before line {node.lineno} or declare global/nonlocal if intentional.",
                )

    def visit_Name(self, node: ast.Name):
        if isinstance(node.ctx, ast.Load):
            self._check_name_read(node)

    def visit_BinOp(self, node: ast.BinOp):
        self.visit(node.left)
        self.visit(node.right)
        if isinstance(node.op, (ast.Div, ast.FloorDiv, ast.Mod)):
            if isinstance(node.right, ast.Constant) and node.right.value == 0:
                self.add_finding(
                    title="Division by zero literal",
                    description="Expression divides directly by literal 0.",
                    category="Arithmetic Error",
                    severity="Critical",
                    confidence=0.99,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST BinOp({type(node.op).__name__}) with literal divisor 0 at line {node.lineno}.",
                    root_cause="The denominator is explicitly 0.",
                    why_it_occurs="Constant divisor evaluates to zero unconditionally.",
                    triggering_condition="Unconditional execution of this expression.",
                    expected_behavior="Valid non-zero divisor or explicit error handling.",
                    actual_behavior="Raises ZeroDivisionError at runtime.",
                    potential_impact="Application crash and failed calculation.",
                    suggested_solution="Validate divisor != 0 or replace invalid constant divisor.",
                )
            elif isinstance(node.right, (ast.Name, ast.Call)):
                divisor_desc = (
                    node.right.id
                    if isinstance(node.right, ast.Name)
                    else "len(...)"
                )
                if not self._is_guarded_divisor(node, divisor_desc):
                    self.add_finding(
                        title="Potential division by zero",
                        description=f"Division using '{divisor_desc}' lacks a visible zero-denominator guard.",
                        category="Arithmetic Error",
                        severity="Critical",
                        confidence=0.91,
                        start_line=node.lineno,
                        end_line=getattr(node, "end_lineno", node.lineno),
                        evidence=f"AST BinOp({type(node.op).__name__}) with unguarded divisor '{divisor_desc}' at line {node.lineno}.",
                        root_cause=f"Denominator '{divisor_desc}' can evaluate to 0 (or empty sequence length) without an explicit check.",
                        why_it_occurs="Missing conditional validation (`if divisor == 0`) or ZeroDivisionError handling prior to division.",
                        triggering_condition=f"Passing 0 or an empty collection for '{divisor_desc}'.",
                        expected_behavior="Return a safe fallback or raise a descriptive ValueError when denominator is 0.",
                        actual_behavior="Raises unhandled ZeroDivisionError and terminates execution.",
                        potential_impact="Service crash or unhandled error on zero/empty edge-case inputs.",
                        suggested_solution=f"Add an explicit guard (`if {divisor_desc if divisor_desc != 'len(...)' else 'not values'} == 0: raise ValueError(...)`) before performing division.",
                    )

    def visit_Try(self, node: ast.Try):
        for stmt in node.body:
            self.visit(stmt)
        for handler in node.handlers:
            if handler.type is None:
                self.add_finding(
                    title="Bare except clause swallows all exceptions",
                    description="Bare `except:` catches SystemExit, KeyboardInterrupt, and unexpected errors silently.",
                    category="Exception Handling",
                    severity="Medium",
                    confidence=0.89,
                    start_line=handler.lineno,
                    end_line=getattr(handler, "end_lineno", handler.lineno),
                    evidence=f"AST ExceptHandler(type=None) at line {handler.lineno}.",
                    root_cause="Exception handler specifies no exception class.",
                    why_it_occurs="Catch-all bare except blocks mask real bugs and hinder debugging.",
                    triggering_condition="Any exception raised within the try block.",
                    expected_behavior="Catch specific expected exceptions (e.g., ValueError, KeyError) and handle clearly.",
                    actual_behavior="All errors including KeyboardInterrupt are caught silently.",
                    potential_impact="Hidden failures, corrupted state, and difficult troubleshooting.",
                    suggested_solution="Replace `except:` with `except Exception as exc:` or a specific exception class.",
                )
            else:
                self.visit(handler.type)
            if handler.name:
                self.scope_stack[-1].add(handler.name)
                if self.current_function_assigned_so_far[-1] is not None:
                    self.current_function_assigned_so_far[-1].add(handler.name)
            for hstmt in handler.body:
                self.visit(hstmt)
        for stmt in node.orelse + node.finalbody:
            self.visit(stmt)

    def visit_Call(self, node: ast.Call):
        func_name = ""
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
            # Check same-file function call arity & kwargs when known
            if func_name in self.top_level_funcs and func_name in self.scope_stack[0]:
                sig = self.top_level_funcs[func_name]
                has_starred_args = any(isinstance(a, ast.Starred) for a in node.args)
                has_dbl_starred_kw = any(kw.arg is None for kw in node.keywords)
                if not has_starred_args and not has_dbl_starred_kw:
                    kw_names = {kw.arg for kw in node.keywords if kw.arg is not None}
                    unknown_kws = [kw for kw in kw_names if kw not in sig["param_names"]]
                    if unknown_kws and not sig["has_kwarg"]:
                        self.add_finding(
                            title=f"Unexpected keyword argument '{unknown_kws[0]}' in call to '{func_name}()'",
                            description=f"Call passes keyword '{unknown_kws[0]}' which is not a parameter of '{func_name}()'.",
                            category="Call Error",
                            severity="High",
                            confidence=0.95,
                            start_line=node.lineno,
                            end_line=getattr(node, "end_lineno", node.lineno),
                            evidence=f"AST Call '{func_name}(..., {unknown_kws[0]}=...)' does not match signature params {sorted(sig['param_names'])}.",
                            root_cause=f"Function '{func_name}' does not accept keyword argument '{unknown_kws[0]}' and has no **kwargs.",
                            why_it_occurs="Misspelled parameter name or outdated call site.",
                            triggering_condition=f"Executing call at line {node.lineno}.",
                            expected_behavior=f"Pass only valid parameters: {', '.join(sorted(sig['param_names']))}.",
                            actual_behavior=f"Raises TypeError: {func_name}() got an unexpected keyword argument '{unknown_kws[0]}'.",
                            potential_impact="Runtime TypeError crash.",
                            suggested_solution=f"Update keyword argument '{unknown_kws[0]}' to match '{func_name}()' signature.",
                        )
                    else:
                        pos_count = len(node.args)
                        # Account for required args supplied via keyword
                        total_supplied = pos_count + len(kw_names & sig["param_names"])
                        if pos_count > sig["max_pos"] and not sig["has_vararg"]:
                            self.add_finding(
                                title=f"Too many positional arguments in call to '{func_name}()'",
                                description=f"Call to '{func_name}()' passes {pos_count} positional arguments, but function accepts at most {sig['max_pos']}.",
                                category="Call Error",
                                severity="High",
                                confidence=0.95,
                                start_line=node.lineno,
                                end_line=getattr(node, "end_lineno", node.lineno),
                                evidence=f"AST Call to '{func_name}' at line {node.lineno} supplies {pos_count} positional arguments (max {sig['max_pos']}).",
                                root_cause=f"Argument count exceeds function definition arity.",
                                why_it_occurs="Extra argument passed or signature changed.",
                                triggering_condition=f"Executing line {node.lineno}.",
                                expected_behavior=f"Supply between {sig['min_pos']} and {sig['max_pos']} arguments.",
                                actual_behavior=f"Raises TypeError: {func_name}() takes {sig['max_pos']} positional arguments but {pos_count} were given.",
                                potential_impact="Runtime TypeError crash.",
                                suggested_solution=f"Match the argument count of '{func_name}()'.",
                            )
                        elif total_supplied < sig["min_pos"]:
                            self.add_finding(
                                title=f"Missing required argument(s) in call to '{func_name}()'",
                                description=f"Call to '{func_name}()' supplies {total_supplied} arguments, fewer than required {sig['min_pos']}.",
                                category="Call Error",
                                severity="High",
                                confidence=0.94,
                                start_line=node.lineno,
                                end_line=getattr(node, "end_lineno", node.lineno),
                                evidence=f"AST Call to '{func_name}' at line {node.lineno} supplies {total_supplied} args (requires {sig['min_pos']}).",
                                root_cause=f"Required positional parameter(s) omitted in call to '{func_name}()'.",
                                why_it_occurs="Missing argument at call site.",
                                triggering_condition=f"Executing line {node.lineno}.",
                                expected_behavior=f"Provide all {sig['min_pos']} required arguments.",
                                actual_behavior=f"Raises TypeError: {func_name}() missing required positional argument.",
                                potential_impact="Runtime TypeError crash.",
                                suggested_solution=f"Pass all required arguments to '{func_name}()'.",
                            )

        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr

        # Security checks (Bandit-style)
        if func_name in {"eval", "exec"}:
            self.add_finding(
                title=f"Dangerous dynamic code execution via {func_name}()",
                description=f"Calling {func_name}() executes arbitrary strings as Python code.",
                category="Security Vulnerability",
                severity="Critical",
                confidence=0.96,
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
                evidence=f"AST Call to '{func_name}' at line {node.lineno}.",
                root_cause=f"Use of {func_name}() allows arbitrary code injection if untrusted input reaches it.",
                why_it_occurs="Dynamic string evaluation chosen instead of safe parsing like ast.literal_eval or json.loads.",
                triggering_condition="Untrusted or malformed string passed to the function.",
                expected_behavior="Safely parse structured literals or dispatch explicit allowed operations.",
                actual_behavior="Executes arbitrary Python expressions in the current process.",
                potential_impact="Remote Code Execution (RCE) vulnerability.",
                suggested_solution=f"Replace {func_name}() with ast.literal_eval(), json.loads(), or an explicit operator dispatch table.",
            )

        if func_name == "system" and isinstance(node.func, ast.Attribute):
            self.add_finding(
                title="Unsafe shell command execution via os.system()",
                description="os.system() invokes a subshell and is susceptible to command injection.",
                category="Security Vulnerability",
                severity="High",
                confidence=0.92,
                start_line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno),
                evidence=f"AST Call to '*.system()' at line {node.lineno}.",
                root_cause="Shell invocation concatenates arguments into a shell command string.",
                why_it_occurs="Direct shell wrapper used instead of parameterized subprocess.run([...], shell=False).",
                triggering_condition="Input containing shell metacharacters (;, &&, |).",
                expected_behavior="Execute commands via subprocess.run with argument list and shell=False.",
                actual_behavior="Shell interprets metacharacters inside arguments.",
                potential_impact="OS command injection.",
                suggested_solution="Use subprocess.run([...], shell=False, check=True).",
            )

        if func_name in {"loads", "load"} and isinstance(node.func, ast.Attribute):
            if isinstance(node.func.value, ast.Name) and node.func.value.id == "pickle":
                self.add_finding(
                    title="Unsafe deserialization via pickle",
                    description=f"pickle.{func_name}() can execute arbitrary code during deserialization of untrusted data.",
                    category="Security Vulnerability",
                    severity="Critical",
                    confidence=0.95,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST Call to pickle.{func_name}() at line {node.lineno}.",
                    root_cause="Python's pickle format allows object __reduce__ hooks to execute arbitrary callables.",
                    why_it_occurs="Using pickle instead of safe data formats like JSON.",
                    triggering_condition="Untrusted payload passed to pickle deserialization.",
                    expected_behavior="Use json.loads() or validated schema deserialization.",
                    actual_behavior="Arbitrary code execution on crafted input.",
                    potential_impact="Remote Code Execution.",
                    suggested_solution="Replace pickle with json.loads() / json.load().",
                )

        if func_name == "execute" and node.args:
            arg0 = node.args[0]
            if isinstance(arg0, (ast.JoinedStr, ast.BinOp)):
                self.add_finding(
                    title="Potential SQL injection via formatted query string",
                    description="SQL query passed to .execute() uses string formatting or concatenation instead of parameterized bindings.",
                    category="Security Vulnerability",
                    severity="Critical",
                    confidence=0.93,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST Call to *.execute(...) with {type(arg0).__name__} at line {node.lineno}.",
                    root_cause="Dynamic string interpolation embeds variables directly into SQL command text.",
                    why_it_occurs="F-string or + concatenation used instead of DB-API bound placeholders.",
                    triggering_condition="User-controlled string containing quotes or SQL keywords.",
                    expected_behavior="Use parameterized query placeholders (?, %s) with tuple parameters.",
                    actual_behavior="Attacker can alter SQL statement structure.",
                    potential_impact="SQL injection / unauthorized data access.",
                    suggested_solution="Pass parameterized SQL and a separate argument tuple to .execute(sql, (param,)).",
                )

        for kw in node.keywords:
            if kw.arg == "shell" and isinstance(kw.value, ast.Constant) and kw.value.value is True:
                self.add_finding(
                    title="Subprocess invoked with shell=True",
                    description="Passing shell=True to subprocess enables shell injection attacks.",
                    category="Security Vulnerability",
                    severity="High",
                    confidence=0.94,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST Call keyword shell=True at line {node.lineno}.",
                    root_cause="shell=True delegates command parsing to /bin/sh.",
                    why_it_occurs="Explicit shell=True flag set in subprocess call.",
                    triggering_condition="Any dynamic argument passed to subprocess.",
                    expected_behavior="Pass argument array with shell=False.",
                    actual_behavior="Command string parsed by shell.",
                    potential_impact="Arbitrary command execution.",
                    suggested_solution="Pass command as a list of strings and set shell=False.",
                )

        if func_name in {"int", "float"} and node.args:
            arg0 = node.args[0]
            if isinstance(arg0, ast.Call) and isinstance(arg0.func, ast.Name) and arg0.func.id == "input":
                self.add_finding(
                    title="Unhandled exception on unvalidated user input conversion",
                    description=f"Calling {func_name}(input(...)) without try/except raises ValueError on non-numeric input.",
                    category="Exception Handling",
                    severity="Medium",
                    confidence=0.89,
                    start_line=node.lineno,
                    end_line=getattr(node, "end_lineno", node.lineno),
                    evidence=f"AST {func_name}(input(...)) at line {node.lineno}.",
                    root_cause="Direct numeric conversion of raw standard input lacks error handling.",
                    why_it_occurs="User input can be empty or non-numeric, causing ValueError.",
                    triggering_condition="Empty string or alphabetic input entered by user.",
                    expected_behavior="Validate input string and handle ValueError gracefully.",
                    actual_behavior="Program aborts with uncaught ValueError.",
                    potential_impact="Unexpected CLI or request crash.",
                    suggested_solution="Wrap conversion in a try/except ValueError block and validate input.",
                )

        self.generic_visit(node)

    def _contains_len_call(self, node: ast.AST) -> bool:
        return isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "len"

    def _is_guarded_divisor(self, binop_node: ast.BinOp, divisor_name: str) -> bool:
        start = max(0, binop_node.lineno - 7)
        context = "\n".join(self.lines[start : binop_node.lineno])
        guard_patterns = [
            "== 0",
            "!= 0",
            "<= 0",
            "> 0",
            f"not {divisor_name}",
            "ZeroDivisionError",
        ]
        if any(pat in context for pat in guard_patterns):
            return True
        if "if " in context and "len(" in context:
            return True
        if f"if {divisor_name}" in context:
            return True
        window = "\n".join(self.lines[max(0, binop_node.lineno - 8) : min(len(self.lines), binop_node.lineno + 5)])
        if "ZeroDivisionError" in window:
            return True
        return False

    def _check_unreachable(self, stmts: list[ast.stmt]):
        terminated = False
        for stmt in stmts:
            if terminated:
                self.add_finding(
                    title="Unreachable code detected after control-flow exit",
                    description="Statement appears after an unconditional return, raise, break, or continue.",
                    category="Code Quality",
                    severity="Low",
                    confidence=0.95,
                    start_line=stmt.lineno,
                    end_line=getattr(stmt, "end_lineno", stmt.lineno),
                    evidence=f"AST statement after terminal control flow at line {stmt.lineno}.",
                    root_cause="Control flow exits the block before reaching this statement.",
                    why_it_occurs="Leftover debugging lines or misplaced return statement.",
                    triggering_condition="Any invocation of the enclosing block.",
                    expected_behavior="All statements in a block are reachable and intentional.",
                    actual_behavior="Dead code never executes.",
                    potential_impact="Dead logic or skipped cleanup/computation.",
                    suggested_solution="Remove dead statement or move return/raise to the end of the path.",
                )
                break
            if isinstance(stmt, (ast.Return, ast.Raise, ast.Break, ast.Continue)):
                terminated = True


def run_optional_ruff(file_path: Path, rel_path: str, lines: list[str]) -> list[dict[str, Any]]:
    ruff_bin = shutil.which("ruff")
    if not ruff_bin:
        return []
    out: list[dict[str, Any]] = []
    try:
        proc = subprocess.run(
            [ruff_bin, "check", "--output-format", "json", str(file_path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        items = json.loads(proc.stdout or "[]")
        for item in items:
            code = item.get("code") or "RUFF"
            msg = item.get("message") or "Ruff lint finding"
            loc = item.get("location") or {}
            line_no = int(loc.get("row") or 1)
            end_line = int((item.get("end_location") or {}).get("row") or line_no)
            snippet = "\n".join(lines[max(0, line_no - 1) : min(len(lines), end_line)])
            sev = "High" if code.startswith(("F8", "E9")) else "Medium" if code.startswith(("F", "B", "S")) else "Low"
            out.append(
                {
                    "bug_title": f"Ruff {code}: {msg}",
                    "bug_description": msg,
                    "bug_category": "Static Lint",
                    "severity": sev,
                    "confidence_score": 0.94,
                    "analyzer_source": "Ruff",
                    "evidence": f"ruff {code} at {rel_path}:{line_no}",
                    "file_path": rel_path,
                    "start_line": line_no,
                    "end_line": end_line,
                    "original_code": snippet,
                    "root_cause": msg,
                    "why_it_occurs": f"Detected by Ruff rule {code}.",
                    "triggering_condition": f"Executing or linting {rel_path}:{line_no}.",
                    "expected_behavior": "Code satisfies static lint and scope checks cleanly.",
                    "actual_behavior": msg,
                    "potential_impact": "Runtime failure or code quality defect.",
                    "suggested_solution": (item.get("fix") or {}).get("message") or f"Resolve Ruff {code} at line {line_no}.",
                }
            )
    except Exception:
        return []
    return out


def run_optional_bandit(file_path: Path, rel_path: str, lines: list[str]) -> list[dict[str, Any]]:
    bandit_bin = shutil.which("bandit")
    if not bandit_bin:
        return []
    out: list[dict[str, Any]] = []
    try:
        proc = subprocess.run(
            [bandit_bin, "-f", "json", "-q", str(file_path)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        data = json.loads(proc.stdout or "{}")
        for issue in data.get("results", []):
            line_no = int(issue.get("line_number") or 1)
            test_id = issue.get("test_id") or "B000"
            msg = issue.get("issue_text") or "Security issue"
            sev_raw = str(issue.get("issue_severity") or "MEDIUM").upper()
            sev = "Critical" if sev_raw == "HIGH" else "High" if sev_raw == "MEDIUM" else "Low"
            snippet = lines[line_no - 1] if 0 < line_no <= len(lines) else ""
            out.append(
                {
                    "bug_title": f"Bandit {test_id}: {msg}",
                    "bug_description": msg,
                    "bug_category": "Security Vulnerability",
                    "severity": sev,
                    "confidence_score": 0.92,
                    "analyzer_source": "Bandit",
                    "evidence": f"bandit {test_id} ({sev_raw}) at {rel_path}:{line_no}",
                    "file_path": rel_path,
                    "start_line": line_no,
                    "end_line": line_no,
                    "original_code": snippet,
                    "root_cause": msg,
                    "why_it_occurs": f"Flagged by Bandit security rule {test_id}.",
                    "triggering_condition": "Untrusted input reaching flagged API.",
                    "expected_behavior": "Use safe, parameterized or non-shell APIs.",
                    "actual_behavior": msg,
                    "potential_impact": "Security vulnerability in runtime execution.",
                    "suggested_solution": f"Remediate Bandit {test_id}: {msg}",
                }
            )
    except Exception:
        return []
    return out


def analyze_file(file_path: str, rel_path: str, project_root_arg: str | None = None) -> dict[str, Any]:
    path = Path(file_path)
    source = path.read_text(encoding="utf-8", errors="replace")
    if not source.strip():
        return {"findings": []}

    lines = source.splitlines()
    findings: list[dict[str, Any]] = []
    project_root = Path(project_root_arg).resolve() if project_root_arg else path.parent.resolve()

    try:
        tree = ast.parse(source, filename=rel_path)
    except SyntaxError as err:
        line_no = err.lineno or 1
        snippet = lines[line_no - 1] if 0 < line_no <= len(lines) else ""
        findings.append(
            {
                "bug_title": f"Python SyntaxError: {err.msg}",
                "bug_description": f"File failed Python AST parsing at line {line_no}: {err.msg}.",
                "bug_category": "Syntax Error",
                "severity": "Critical",
                "confidence_score": 1.0,
                "analyzer_source": "Python 3.11 Compiler",
                "evidence": f"ast.parse SyntaxError: {err.msg} (line {line_no}, offset {err.offset})",
                "file_path": rel_path,
                "start_line": line_no,
                "end_line": line_no,
                "original_code": snippet,
                "root_cause": f"Invalid Python syntax ({err.msg}) prevents module compilation.",
                "why_it_occurs": "Missing colon, mismatched bracket/quote, or invalid indentation.",
                "triggering_condition": "Importing or executing this file.",
                "expected_behavior": "Valid Python 3.11 syntax that compiles cleanly.",
                "actual_behavior": f"SyntaxError raised at line {line_no}.",
                "potential_impact": "Module cannot load or run.",
                "suggested_solution": "Fix the syntax mistake at the reported line and offset.",
            }
        )
        return {"findings": findings}

    # Verify symbol table compiles cleanly (catches semantic compiler errors like return outside function)
    try:
        symtable.symtable(source, rel_path, "exec")
    except SyntaxError as err:
        line_no = err.lineno or 1
        snippet = lines[line_no - 1] if 0 < line_no <= len(lines) else ""
        findings.append(
            {
                "bug_title": f"Python Compiler Error: {err.msg}",
                "bug_description": f"Symbol table compilation failed at line {line_no}: {err.msg}.",
                "bug_category": "Syntax Error",
                "severity": "Critical",
                "confidence_score": 1.0,
                "analyzer_source": "Python 3.11 Compiler",
                "evidence": f"symtable SyntaxError: {err.msg} at line {line_no}",
                "file_path": rel_path,
                "start_line": line_no,
                "end_line": line_no,
                "original_code": snippet,
                "root_cause": err.msg,
                "why_it_occurs": "Illegal Python statement placement or duplicate parameter/declaration.",
                "triggering_condition": "Compiling or importing the module.",
                "expected_behavior": "Valid Python semantic structure.",
                "actual_behavior": f"SyntaxError: {err.msg}",
                "potential_impact": "Module fails to compile.",
                "suggested_solution": "Correct the invalid statement or scope declaration.",
            }
        )

    visitor = ScopeAnalyzer(lines, rel_path, project_root=project_root)
    visitor.visit(tree)
    findings.extend(visitor.findings)

    # Check unused imports (skip __init__.py re-exports)
    if Path(rel_path).name != "__init__.py":
        for imp_name, line_no in visitor.imported_names.items():
            if imp_name not in visitor.used_names and not imp_name.startswith("_"):
                snippet = lines[line_no - 1] if 0 < line_no <= len(lines) else ""
                findings.append(
                    {
                        "bug_title": f"Unused import '{imp_name}'",
                        "bug_description": f"Imported symbol '{imp_name}' is never referenced in {rel_path}.",
                        "bug_category": "Code Quality",
                        "severity": "Low",
                        "confidence_score": 0.90,
                        "analyzer_source": "Python 3.11 AST",
                        "evidence": f"Import '{imp_name}' at line {line_no} has zero Load references.",
                        "file_path": rel_path,
                        "start_line": line_no,
                        "end_line": line_no,
                        "original_code": snippet,
                        "root_cause": "Module or symbol was imported but never used.",
                        "why_it_occurs": "Refactored code left behind unused import statements.",
                        "triggering_condition": "Static code inspection.",
                        "expected_behavior": "Only required dependencies are imported.",
                        "actual_behavior": "Extra unused import increases startup overhead and clutter.",
                        "potential_impact": "Minor memory/import overhead and lint warning.",
                        "suggested_solution": f"Remove unused import '{imp_name}'.",
                    }
                )

    # Merge Ruff / Bandit results if installed, avoiding duplicate line+category noise
    existing_lines = {(f["start_line"], f["bug_category"]) for f in findings}
    for extra in run_optional_ruff(path, rel_path, lines) + run_optional_bandit(path, rel_path, lines):
        if (extra["start_line"], extra["bug_category"]) not in existing_lines:
            findings.append(extra)
            existing_lines.add((extra["start_line"], extra["bug_category"]))

    return {"findings": findings}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python_ast_scanner.py <abs_path> <rel_path> [project_root]"}))
        sys.exit(1)
    root_arg = sys.argv[3] if len(sys.argv) >= 4 else None
    result = analyze_file(sys.argv[1], sys.argv[2], root_arg)
    print(json.dumps(result))
