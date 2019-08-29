-- data
INSERT INTO department
    (id, name)
VALUES
    (1, 'HR'),
    (2, 'Sales'),
    (3, 'Tech')
;

INSERT INTO employee
    (id, fname, lname, phonenumber, manager_id, department_id, salary, hiredate)
VALUES
    (1, 'James', 'Smith', 1234567890, NULL, 1, 1000, '2002-01-01'),
    (2, 'John', 'Johnson', 2468101214, '1', 1, 400, '2005-03-23'),
    (3, 'Michael', 'Williams', 1357911131, '1', 2, 600, '2009-05-12'),
    (4, 'Johnathon', 'Smith', 1212121212, '2', 1, 500, '2016-07-24')
;

INSERT INTO customer
    (id, fname, lname, email, phonenumber, preferred_contact)
VALUES
    (1, 'William', 'Jones', 'william.jones@example.com', '3347927472', 'PHONE'),
    (2, 'David', 'Miller', 'dmiller@example.net', '2137921892', 'EMAIL'),
    (3, 'Richard', 'Davis', 'richard0123@example.com', NULL, 'EMAIL')
;

INSERT INTO car
    (id, customer_id, employee_id, model, status, total_cost)
VALUES
    ('1', '1', '2', 'Ford F-150', 'READY', '230'),
    ('2', '1', '2', 'Ford F-150', 'READY', '200'),
    ('3', '2', '1', 'Ford Mustang', 'WAITING', '100'),
    ('4', '3', '3', 'Toyota Prius', 'WORKING', '1254')
;