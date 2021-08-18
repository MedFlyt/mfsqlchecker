CREATE TABLE department (
    id SERIAL8 PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE employee (
	id SERIAL8 PRIMARY KEY,
    fname TEXT NOT NULL,
    lname TEXT NOT NULL,
    phonenumber TEXT,
    manager_id INT8 REFERENCES employee(id),
    department_id INT8 NOT NULL REFERENCES department(id),
    salary INT NOT NULL,
    hiredate DATE NOT NULL
);

CREATE TABLE customer (
    id SERIAL8 PRIMARY KEY,
    fname TEXT NOT NULL,
    lname TEXT NOT NULL,
    email TEXT NOT NULL,
    phonenumber TEXT,
    preferred_contact TEXT NOT NULL
);

CREATE TABLE car (
    id SERIAL8 PRIMARY KEY,
    customer_id INT8 NOT NULL REFERENCES customer(id),
    employee_id INT8 NOT NULL REFERENCES employee(id),
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    total_cost INT NOT NULL
);

CREATE INDEX weird_index ON employee(COALESCE(manager_id, 0));
