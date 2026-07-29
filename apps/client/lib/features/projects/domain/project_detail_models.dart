import 'dart:typed_data';

import 'project_models.dart';

class ProjectSettings {
  const ProjectSettings({
    required this.key,
    required this.name,
    required this.dir,
    this.projectId,
    this.metadata,
  });

  final String? projectId;
  final String key;
  final String name;
  final String dir;
  final String? metadata;
}

class ProjectSkill {
  const ProjectSkill({
    required this.name,
    required this.description,
    this.path,
  });

  final String name;
  final String description;
  final String? path;
}

class ProjectDocumentationEntry {
  const ProjectDocumentationEntry({required this.name, required this.type});

  final String name;
  final String type;

  bool get isDirectory => type == 'directory' || type == 'dir';
}

class ProjectDocumentationListing {
  const ProjectDocumentationListing({
    required this.exists,
    required this.entries,
  });

  final bool exists;
  final List<ProjectDocumentationEntry> entries;
}

class ProjectFilePreview {
  const ProjectFilePreview({
    required this.path,
    required this.bytes,
    this.contentType,
  });

  final String path;
  final Uint8List bytes;
  final String? contentType;

  bool get isImage =>
      contentType?.startsWith('image/') == true ||
      RegExp(
        r'\.(png|jpe?g|gif|webp|svg|bmp|ico)$',
        caseSensitive: false,
      ).hasMatch(path);
}

class WorkspaceMember {
  const WorkspaceMember({
    required this.userId,
    required this.email,
    required this.role,
    this.githubLogin,
    this.avatarUrl,
  });

  final String userId;
  final String email;
  final String role;
  final String? githubLogin;
  final String? avatarUrl;

  String get displayName {
    final login = githubLogin?.trim();
    return login?.isNotEmpty == true ? '@$login' : email;
  }
}

class ProjectAccessReference {
  const ProjectAccessReference({
    required this.peonId,
    required this.projectKey,
    this.projectId,
  });

  final String peonId;
  final String projectKey;
  final String? projectId;
}

class MemberAccess {
  const MemberAccess({required this.peonIds, required this.projects});

  final List<String> peonIds;
  final List<ProjectAccessReference> projects;
}

class ProjectMembersSnapshot {
  const ProjectMembersSnapshot({
    required this.members,
    required this.accessByMember,
  });

  final List<WorkspaceMember> members;
  final Map<String, MemberAccess> accessByMember;
}

class ProjectDetailState {
  const ProjectDetailState({
    required this.project,
    this.settings,
    this.documentation,
    this.documentationSource,
    this.documentationPath,
    this.skills,
    this.members,
    this.filePreview,
    this.loading = false,
    this.saving = false,
    this.saved = false,
    this.message,
    this.code,
  });

  final PeonProject project;
  final ProjectSettings? settings;
  final ProjectDocumentationListing? documentation;
  final String? documentationSource;
  final String? documentationPath;
  final List<ProjectSkill>? skills;
  final ProjectMembersSnapshot? members;
  final ProjectFilePreview? filePreview;
  final bool loading;
  final bool saving;
  final bool saved;
  final String? message;
  final String? code;

  ProjectDetailState copyWith({
    PeonProject? project,
    ProjectSettings? settings,
    ProjectDocumentationListing? documentation,
    String? documentationSource,
    String? documentationPath,
    List<ProjectSkill>? skills,
    ProjectMembersSnapshot? members,
    ProjectFilePreview? filePreview,
    bool? loading,
    bool? saving,
    bool? saved,
    String? message,
    String? code,
    bool clearMessage = false,
    bool clearDocumentationSource = false,
  }) {
    return ProjectDetailState(
      project: project ?? this.project,
      settings: settings ?? this.settings,
      documentation: documentation ?? this.documentation,
      documentationSource: clearDocumentationSource
          ? null
          : documentationSource ?? this.documentationSource,
      documentationPath: documentationPath ?? this.documentationPath,
      skills: skills ?? this.skills,
      members: members ?? this.members,
      filePreview: filePreview ?? this.filePreview,
      loading: loading ?? this.loading,
      saving: saving ?? this.saving,
      saved: saved ?? this.saved,
      message: clearMessage ? null : message ?? this.message,
      code: clearMessage ? null : code ?? this.code,
    );
  }
}
