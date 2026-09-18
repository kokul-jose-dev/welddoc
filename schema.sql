-- WeldDoc Database Schema for Azure SQL / SQL Server
-- ============================================================

-- 1. CLIENTS
CREATE TABLE weldoc_clients (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(200) NOT NULL,
    street NVARCHAR(200),
    zip_code NVARCHAR(20),
    location NVARCHAR(200),
    remarks NVARCHAR(MAX),
    archived BIT DEFAULT 0
);

-- 2. PROJECTS
CREATE TABLE weldoc_projects (
    id INT IDENTITY(1,1) PRIMARY KEY,
    client_id INT NOT NULL,
    ist_project_no NVARCHAR(100) NOT NULL,
    title NVARCHAR(300),
    location NVARCHAR(200),
    order_no NVARCHAR(100),
    description NVARCHAR(MAX),
    status NVARCHAR(50) DEFAULT 'Not started',
    archived BIT DEFAULT 0,
    sharepoint_drive_id NVARCHAR(500),
    sharepoint_folder_id NVARCHAR(500),
    sharepoint_folder_url NVARCHAR(1000),
    CONSTRAINT FK_projects_client FOREIGN KEY (client_id) REFERENCES weldoc_clients(id)
);

-- 3. PIPELINES
CREATE TABLE weldoc_pipelines (
    id INT IDENTITY(1,1) PRIMARY KEY,
    project_id INT NOT NULL,
    no NVARCHAR(100) NOT NULL,
    plant NVARCHAR(50),
    status INT DEFAULT 0,
    doc_iso NVARCHAR(500),
    doc_builder NVARCHAR(500),
    doc_final NVARCHAR(500),
    welding_start NVARCHAR(20),
    welding_end NVARCHAR(20),
    welding_remarks NVARCHAR(MAX),
    archived BIT DEFAULT 0,
    CONSTRAINT FK_pipelines_project FOREIGN KEY (project_id) REFERENCES weldoc_projects(id)
);

-- 4. GLOBAL MATERIALS (Catalog)
CREATE TABLE weldoc_global_materials (
    id INT IDENTITY(1,1) PRIMARY KEY,
    category NVARCHAR(100),
    dn1 NVARCHAR(50),
    dn2 NVARCHAR(50),
    dn3 NVARCHAR(50),
    dn4 NVARCHAR(50),
    dn5 NVARCHAR(50),
    dn6 NVARCHAR(50),
    diameter NVARCHAR(50),
    thickness NVARCHAR(50),
    surface NVARCHAR(100),
    item_description NVARCHAR(300),
    material_code NVARCHAR(50),
    dien_no NVARCHAR(100),
    archived BIT DEFAULT 0
);

-- 5. PROJECT MATERIALS (Project-specific certs & heats)
CREATE TABLE weldoc_project_materials (
    id INT IDENTITY(1,1) PRIMARY KEY,
    project_id INT NOT NULL,
    global_material_id INT NOT NULL,
    certificate NVARCHAR(100),
    heat_no NVARCHAR(200),
    waz_pdf_url NVARCHAR(500),
    archived BIT DEFAULT 0,
    CONSTRAINT FK_projmat_project FOREIGN KEY (project_id) REFERENCES weldoc_projects(id),
    CONSTRAINT FK_projmat_global FOREIGN KEY (global_material_id) REFERENCES weldoc_global_materials(id)
);

-- 6. PIPELINE MATERIALS (Position in pipeline builder)
CREATE TABLE weldoc_pipeline_materials (
    id INT IDENTITY(1,1) PRIMARY KEY,
    pipeline_id INT NOT NULL,
    project_material_id INT NOT NULL,
    position NVARCHAR(5),
    waz_no NVARCHAR(50),
    waz_package_url NVARCHAR(500),
    start_of_plumbing BIT DEFAULT 0,
    end_of_plumbing BIT DEFAULT 0,
    archived BIT DEFAULT 0,
    CONSTRAINT FK_plmat_pipeline FOREIGN KEY (pipeline_id) REFERENCES weldoc_pipelines(id),
    CONSTRAINT FK_plmat_projmat FOREIGN KEY (project_material_id) REFERENCES weldoc_project_materials(id)
);

-- 7. PIPELINE MATERIAL CONNECTIONS (Graph topology)
CREATE TABLE weldoc_pipeline_material_connections (
    pipeline_material_id INT NOT NULL,
    connected_id INT NOT NULL,
    CONSTRAINT PK_plmat_connections PRIMARY KEY (pipeline_material_id, connected_id),
    CONSTRAINT FK_conn_source FOREIGN KEY (pipeline_material_id) REFERENCES weldoc_pipeline_materials(id),
    CONSTRAINT FK_conn_target FOREIGN KEY (connected_id) REFERENCES weldoc_pipeline_materials(id)
);

-- 8. WELDERS & PERSONNEL
CREATE TABLE weldoc_welders (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(200) NOT NULL,
    no NVARCHAR(50),
    signature_url NVARCHAR(500),
    archived BIT DEFAULT 0
);

-- 9. WELDER CERTIFICATES
CREATE TABLE weldoc_weldercertificate (
    id INT IDENTITY(1,1) PRIMARY KEY,
    welder_id INT NOT NULL,
    cert_no NVARCHAR(100) NOT NULL,
    process NVARCHAR(50),
    standard NVARCHAR(100),
    valid_until NVARCHAR(20),
    renewal_due NVARCHAR(20),
    pdf_url NVARCHAR(500),
    archived BIT DEFAULT 0,
    CONSTRAINT FK_cert_welder FOREIGN KEY (welder_id) REFERENCES weldoc_welders(id)
);

-- 10. WELDS
CREATE TABLE weldoc_welds (
    id INT IDENTITY(1,1) PRIMARY KEY,
    pipeline_id INT NOT NULL,
    weld_no NVARCHAR(20),
    between_a NVARCHAR(5),
    between_b NVARCHAR(5),
    type NVARCHAR(10),
    procedure NVARCHAR(50),
    welding_wire NVARCHAR(200),
    welder NVARCHAR(200),
    inspector NVARCHAR(200),
    welder_id INT,
    inspector_id INT,
    date NVARCHAR(20),
    visual NVARCHAR(20),
    endoscopy NVARCHAR(20),
    endoscopy_video_url NVARCHAR(500),
    endoscopy_image_url NVARCHAR(500),
    remarks NVARCHAR(MAX),
    archived BIT DEFAULT 0,
    CONSTRAINT FK_welds_pipeline FOREIGN KEY (pipeline_id) REFERENCES weldoc_pipelines(id),
    CONSTRAINT FK_welds_welder FOREIGN KEY (welder_id) REFERENCES weldoc_welders(id),
    CONSTRAINT FK_welds_inspector FOREIGN KEY (inspector_id) REFERENCES weldoc_welders(id)
);

-- 11. USERS
CREATE TABLE weldoc_users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(200) NOT NULL,
    email NVARCHAR(200) NOT NULL UNIQUE,
    password_hash NVARCHAR(500) NOT NULL,
    role NVARCHAR(50) NOT NULL,
    archived BIT DEFAULT 0
);

-- ============================================================
-- PERFORMANCE INDEXES
-- ============================================================
CREATE INDEX IX_projects_client ON weldoc_projects(client_id, archived);
CREATE INDEX IX_pipelines_project ON weldoc_pipelines(project_id, archived);
CREATE INDEX IX_plmat_pipeline ON weldoc_pipeline_materials(pipeline_id, archived);
CREATE INDEX IX_plmat_projmat ON weldoc_pipeline_materials(project_material_id);
CREATE INDEX IX_projmat_project ON weldoc_project_materials(project_id, archived);
CREATE INDEX IX_projmat_global ON weldoc_project_materials(global_material_id);
CREATE INDEX IX_welds_pipeline ON weldoc_welds(pipeline_id, archived);
CREATE INDEX IX_weldercert_welder ON weldoc_weldercertificate(welder_id, archived);
CREATE INDEX IX_clients_archived ON weldoc_clients(archived);
CREATE INDEX IX_globalmat_archived ON weldoc_global_materials(archived);