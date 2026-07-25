use dialoguer::{theme::ColorfulTheme, MultiSelect};
use std::error::Error;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process;
use std::time::{SystemTime, UNIX_EPOCH};

/// The skill ships as a lean SKILL.md plus on-demand reference files
/// (progressive disclosure). Every embedded file is installed relative to the
/// skill directory, so adding a reference here is the only step needed to make
/// it reachable from an installed skill.
struct EmbeddedSkillFile {
    relative_path: &'static str,
    contents: &'static str,
}

const EMBEDDED_DEV_BROWSER_SKILL_FILES: [EmbeddedSkillFile; 6] = [
    EmbeddedSkillFile {
        relative_path: "SKILL.md",
        contents: include_str!("../../skills/dev-browser/SKILL.md"),
    },
    EmbeddedSkillFile {
        relative_path: "references/browsers-and-pages.md",
        contents: include_str!("../../skills/dev-browser/references/browsers-and-pages.md"),
    },
    EmbeddedSkillFile {
        relative_path: "references/interactive-loop.md",
        contents: include_str!("../../skills/dev-browser/references/interactive-loop.md"),
    },
    EmbeddedSkillFile {
        relative_path: "references/scripting.md",
        contents: include_str!("../../skills/dev-browser/references/scripting.md"),
    },
    EmbeddedSkillFile {
        relative_path: "references/video-recording.md",
        contents: include_str!("../../skills/dev-browser/references/video-recording.md"),
    },
    EmbeddedSkillFile {
        relative_path: "references/diagnostics-and-recovery.md",
        contents: include_str!("../../skills/dev-browser/references/diagnostics-and-recovery.md"),
    },
];

struct InstallTarget {
    prompt_label: &'static str,
    root_display: &'static str,
    file_display: &'static str,
    root_relative_path: &'static str,
}

const INSTALL_TARGETS: [InstallTarget; 2] = [
    InstallTarget {
        prompt_label: "~/.claude/skills/dev-browser/",
        root_display: "~/.claude/skills",
        file_display: "~/.claude/skills/dev-browser/",
        root_relative_path: ".claude/skills",
    },
    InstallTarget {
        prompt_label: "~/.agents/skills/dev-browser/",
        root_display: "~/.agents/skills",
        file_display: "~/.agents/skills/dev-browser/",
        root_relative_path: ".agents/skills",
    },
];

enum SyncResult {
    Installed,
    Updated,
    AlreadyInstalled,
}

enum InstallTargetSelection {
    Prompt,
    Selected(Vec<usize>),
}

pub fn install_skill(install_claude: bool, install_agents: bool) -> Result<(), Box<dyn Error>> {
    let selections = match resolve_install_target_selection(
        install_claude,
        install_agents,
        interactive_terminal_available(),
    ) {
        InstallTargetSelection::Prompt => {
            let Some(selections) = prompt_for_install_targets()? else {
                println!("Cancelled.");
                return Ok(());
            };

            selections
        }
        InstallTargetSelection::Selected(selections) => selections,
    };

    let home_dir =
        dirs::home_dir().ok_or("Could not determine the home directory for skill installation.")?;

    if selections.is_empty() {
        println!("No install targets selected.");
        return Ok(());
    }

    for selection in selections {
        let target = &INSTALL_TARGETS[selection];
        let result = install_target(&home_dir, target)?;
        match result {
            SyncResult::Installed => {
                println!("Installed dev-browser skill to {}", target.file_display);
            }
            SyncResult::Updated => {
                println!("Updated dev-browser skill at {}", target.file_display);
            }
            SyncResult::AlreadyInstalled => {
                println!(
                    "dev-browser skill is already installed at {}",
                    target.file_display
                );
            }
        }
    }

    Ok(())
}

fn resolve_install_target_selection(
    install_claude: bool,
    install_agents: bool,
    interactive_terminal: bool,
) -> InstallTargetSelection {
    if install_claude || install_agents {
        let mut selections = Vec::new();
        if install_claude {
            selections.push(0);
        }
        if install_agents {
            selections.push(1);
        }

        return InstallTargetSelection::Selected(selections);
    }

    if interactive_terminal {
        InstallTargetSelection::Prompt
    } else {
        InstallTargetSelection::Selected((0..INSTALL_TARGETS.len()).collect())
    }
}

fn prompt_for_install_targets() -> Result<Option<Vec<usize>>, Box<dyn Error>> {
    let options: Vec<&str> = INSTALL_TARGETS
        .iter()
        .map(|target| target.prompt_label)
        .collect();
    let defaults = vec![true; options.len()];

    let selections = MultiSelect::with_theme(&ColorfulTheme::default())
        .with_prompt("Select skill directories to install dev-browser into")
        .items(&options)
        .defaults(&defaults)
        .interact_opt()?;

    Ok(selections)
}

fn install_target(home_dir: &Path, target: &InstallTarget) -> Result<SyncResult, Box<dyn Error>> {
    let root_dir = home_dir.join(target.root_relative_path);
    ensure_directory(&root_dir, target.root_display, true)?;

    let skill_dir = root_dir.join("dev-browser");
    ensure_directory(&skill_dir, target.prompt_label.trim_end_matches('/'), false)?;

    let mut installed = false;
    let mut updated = false;

    for file in EMBEDDED_DEV_BROWSER_SKILL_FILES.iter() {
        let destination = skill_dir.join(file.relative_path);
        if let Some(parent) = destination.parent() {
            ensure_directory(parent, &parent.display().to_string(), false)?;
        }

        match sync_skill_file(&destination, file.contents)? {
            SyncResult::Installed => installed = true,
            SyncResult::Updated => updated = true,
            SyncResult::AlreadyInstalled => {}
        }
    }

    // A partially refreshed skill directory still reads as an update: the
    // headline result describes the skill as a whole, not one file.
    Ok(match (installed, updated) {
        (true, _) => SyncResult::Installed,
        (false, true) => SyncResult::Updated,
        (false, false) => SyncResult::AlreadyInstalled,
    })
}

fn ensure_directory(
    path: &Path,
    display_path: &str,
    announce_create: bool,
) -> Result<(), Box<dyn Error>> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if metadata.is_dir() {
                return Ok(());
            }

            Err(format!("{display_path} exists but is not a directory.").into())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|create_error| {
                format!("Failed to create {display_path}: {create_error}")
            })?;
            if announce_create {
                println!("Created {display_path}");
            }
            Ok(())
        }
        Err(error) => Err(format!("Failed to inspect {display_path}: {error}").into()),
    }
}

fn sync_skill_file(path: &Path, contents: &str) -> Result<SyncResult, Box<dyn Error>> {
    match fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(format!("{} exists but is not a file.", path.display()).into());
            }

            let existing = fs::read_to_string(path)
                .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
            if existing == contents {
                return Ok(SyncResult::AlreadyInstalled);
            }

            atomic_write(path, contents)?;
            Ok(SyncResult::Updated)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            atomic_write(path, contents)?;
            Ok(SyncResult::Installed)
        }
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display()).into()),
    }
}

fn atomic_write(path: &Path, contents: &str) -> Result<(), Box<dyn Error>> {
    let temp_path = temp_path_for(path)?;
    fs::write(&temp_path, contents)
        .map_err(|error| format!("Failed to write {}: {error}", temp_path.display()))?;

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Failed to replace {}: {error}", path.display()).into());
    }

    Ok(())
}

fn temp_path_for(path: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Could not determine a file name for {}", path.display()))?
        .to_string_lossy();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    Ok(path.with_file_name(format!(".{file_name}.tmp-{}-{nonce}", process::id())))
}

fn interactive_terminal_available() -> bool {
    io::stdin().is_terminal() && io::stderr().is_terminal()
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_install_target_selection, InstallTargetSelection, EMBEDDED_DEV_BROWSER_SKILL_FILES,
    };

    #[test]
    fn embedded_skill_is_lean_and_ships_its_references() {
        let skill = EMBEDDED_DEV_BROWSER_SKILL_FILES
            .iter()
            .find(|file| file.relative_path == "SKILL.md")
            .expect("SKILL.md must be embedded");
        assert!(
            skill.contents.lines().count() < 500,
            "SKILL.md must stay under the progressive-disclosure line guideline"
        );

        let references: Vec<&str> = EMBEDDED_DEV_BROWSER_SKILL_FILES
            .iter()
            .map(|file| file.relative_path)
            .filter(|path| path.starts_with("references/"))
            .collect();
        assert!(
            references.len() >= 4,
            "expected the reference files to ship"
        );

        for reference in references {
            assert!(
                skill.contents.contains(reference),
                "SKILL.md must link {reference}"
            );
        }

        for file in EMBEDDED_DEV_BROWSER_SKILL_FILES.iter() {
            assert!(
                !file.contents.trim().is_empty(),
                "{} must not be empty",
                file.relative_path
            );
        }
    }

    #[test]
    fn explicit_claude_flag_skips_prompt() {
        let selection = resolve_install_target_selection(true, false, true);
        assert_selected(selection, &[0]);
    }

    #[test]
    fn explicit_agents_flag_skips_prompt() {
        let selection = resolve_install_target_selection(false, true, true);
        assert_selected(selection, &[1]);
    }

    #[test]
    fn explicit_flags_can_select_both_targets() {
        let selection = resolve_install_target_selection(true, true, false);
        assert_selected(selection, &[0, 1]);
    }

    #[test]
    fn interactive_terminal_without_flags_prompts() {
        let selection = resolve_install_target_selection(false, false, true);
        assert!(matches!(selection, InstallTargetSelection::Prompt));
    }

    #[test]
    fn non_interactive_without_flags_defaults_to_both_targets() {
        let selection = resolve_install_target_selection(false, false, false);
        assert_selected(selection, &[0, 1]);
    }

    fn assert_selected(selection: InstallTargetSelection, expected: &[usize]) {
        match selection {
            InstallTargetSelection::Prompt => panic!("expected explicit selection"),
            InstallTargetSelection::Selected(actual) => assert_eq!(actual, expected),
        }
    }
}
